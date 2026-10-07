# MCP 인터페이스
엔진은 지식 저장소의 모든 읽기·쓰기·검색 기능을 Streamable HTTP 기반 MCP로 제공한다.

## 배경

Claude Code, Codex, Hermes가 같은 지식 저장소를 활용하려면 각 클라이언트 전용 지식 인터페이스 대신 공통 인터페이스가 필요하다. MCP는 외부 클라이언트가 지식을 조회하고 저장하는 경로이며, [설치형 Skills](skills.md)는 이 경로의 설정과 사용 지침을 제공한다.

## 내용

### 제공 범위와 전송

MCP 엔드포인트는 `/mcp`이며, 전송 방식은 Streamable HTTP다. 클라이언트는 각 요청에 엔진의 Bearer 토큰을 보내며, 토큰 발급은 [인증과 권한](auth.md)을 따른다.

서버는 **stateless** 방식을 사용한다. 인증을 통과한 POST마다 새 `McpServer`와 `StreamableHTTPServerTransport`를 만들고, `sessionIdGenerator: undefined`와 `enableJsonResponse: true`를 설정한다. 응답 연결이 닫히면 해당 서버와 전송을 정리한다. 응답에 `mcp-session-id`를 발급하지 않으며, 지속적인 MCP 세션이나 SSE 구독을 유지하지 않는다.

각 요청은 `McpController`의 `McpAuthGuard`로 다시 인증하고, `@CurrentUser()`가 전달한 현재 사용자와 역할만 `McpService`의 도구 핸들러에 연결한다. 따라서 이전 요청의 사용자 신원이나 권한을 재사용하지 않으며, 쓰기 작업의 소유자도 현재 요청의 사용자로 기록한다. SDK의 stateless 전송도 클라이언트 간 메시지 ID 충돌을 막기 위해 요청마다 새 전송을 요구한다. 비동기 쓰기 상태는 MCP 세션이 아니라 작업 큐에 보관하므로, 이후 별도 POST에서 `jobId`로 조회한다.

POST 요청은 `Content-Type: application/json`과 `Accept: application/json, text/event-stream`을 보낸다. JSON 응답을 선택한 서버라도 SDK가 두 미디어 타입을 모두 지원하는 `Accept` 헤더를 요구한다. 인증을 통과한 GET과 DELETE는 `Allow: POST` 헤더와 HTTP 405를 반환한다. GET으로 SSE를 구독하거나 DELETE로 세션을 종료하는 기능은 제공하지 않는다.

`McpModule`은 인증·검색·지식 저장소·쓰기 작업 모듈을 명시적으로 가져온다. `McpService`는 `SearchService`, `KnowledgeRepo`, `WriteJobsService`를 DI로 받아 도구와 서버 지침을 구성하며, `McpController`는 전송의 연결·요청 처리·응답 종료 시 정리를 담당한다. Nest의 JSON 파서가 요청 본문을 먼저 읽으므로, 컨트롤러는 원래 Express 요청·응답과 이미 해석한 `req.body`를 함께 `transport.handleRequest`에 전달한다. SDK가 소비된 요청 스트림을 다시 읽게 하지 않는다.

전송의 근거는 [공식 SDK의 stateless 예제](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts)와 [Streamable HTTP 명세](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)에 기록되어 있다.

### 도구 계약

다섯 도구의 인자는 객체로 전달한다. 아래 반환값은 성공 결과의 데이터 객체다. 서버는 이 객체를 JSON 문자열로 직렬화한 `content: [{ type: "text", text: "..." }]`와 동일한 객체의 `structuredContent`를 함께 반환한다.

| 도구 | 인자 | 성공 반환값 | 권한과 동작 |
| --- | --- | --- | --- |
| `search` | `query: string`은 앞뒤 공백을 제거한 뒤 비어 있지 않아야 한다. 선택 인자 `limit: number`는 1~100의 정수이며, 생략하면 검색 서비스의 기본값 10을 사용한다. | `{ hits: SearchHit[] }` | `viewer`, `editor`, `admin`이 하이브리드 검색을 사용할 수 있다. |
| `read_note` | `path: string`은 비어 있지 않은 저장소 상대 경로다. 검색이나 목록에서 얻은 경로를 사용한다. | `{ path: string, content: string }` | 모든 역할이 `main`의 노트 전체 마크다운을 읽을 수 있다. 노트가 없으면 도구 오류다. |
| `list_notes` | 선택 인자 `prefix: string`으로 저장소 상대 경로 접두사를 지정한다. | 접두사를 생략하거나 `""`로 보내면 `{ files: string[], index: string \| null }`을 반환한다. 비어 있지 않은 접두사를 보내면 `{ files: string[] }`만 반환한다. | 모든 역할이 `main`에서 추적하는 마크다운 파일 목록을 볼 수 있다. `index`는 루트 `index.md`의 내용이며, 파일이 없으면 `null`이다. 별도 `index` 도구는 없다. |
| `write` | `content: string`은 공백만 있는 문자열을 허용하지 않는다. 자연어 편집 지시나 원문을 전달하며, 입력 원문은 그대로 작업에 제출한다. | `{ jobId: string, status: "queued" }` | `editor`, `admin`만 제출할 수 있다. 작업 큐에 등록한 뒤 즉시 반환하며, 저장 완료를 뜻하지 않는다. |
| `get_write_status` | `jobId: string`은 비어 있지 않은 작업 식별자다. | `{ job: WriteJob }` | 모든 역할이 자기 작업만 조회할 수 있으며, `admin`은 모든 사용자의 작업을 조회할 수 있다. 존재하지 않거나 조회 권한이 없는 작업은 같은 도구 오류를 반환한다. |

검색의 인덱스와 결과 구성은 [RAG](rag.md)에 기록한다.

`SearchHit`에는 `path`, `title`, `heading`, `snippet`, `score`, `kind`, `related`가 들어 있다. `kind`는 `wiki`, `journal`, `raw`, `other` 중 하나이며, `related`는 관련 노트 경로 배열이다. 검색 스니펫만으로 판단하지 않고 `read_note`로 관련 노트 전체를 읽는다.

`WriteJob`은 다음 필드를 반환한다.

| 필드 | 타입과 의미 |
| --- | --- |
| `id`, `userId`, `source`, `input` | 작업 ID 문자열, 제출자 ID 숫자, 제출 경로(`mcp` 또는 `dreaming`), 입력 원문 문자열이다. `write`로 제출한 작업의 `source`는 `mcp`다. |
| `status` | `queued`, `running`, `merging`, `succeeded`, `failed` 중 하나다. |
| `summary`, `error` | 결과 요약과 실패 원인으로, 각각 문자열 또는 `null`이다. |
| `commits`, `mergeSha` | 작업 커밋 SHA 문자열 배열과 `main` 반영 SHA 문자열 또는 `null`이다. |
| `createdAt`, `startedAt`, `finishedAt` | ISO-8601 UTC 시각 문자열이다. 시작·종료 전에는 `startedAt`, `finishedAt`이 각각 `null`이다. |

### 도구 오류와 권한

인증 실패 같은 HTTP 계층의 오류와 도구 실행 결과를 구별한다. 인증된 `viewer`가 `write`를 호출하면 HTTP 403이 아니라 MCP 도구 결과의 `isError: true`와 설명 텍스트를 받는다. 노트가 없거나 입력 스키마가 유효하지 않은 경우, 도구 실행 중 예외가 발생한 경우에도 `isError: true`를 반환한다. SDK는 입력 검증 실패와 도구 핸들러의 예외를 이 도구 오류 형식으로 변환한다. 오류 결과에는 성공 데이터의 `structuredContent`를 제공하지 않는다.

`get_write_status`는 작업이 없는 경우와 다른 사용자의 작업이라 접근할 수 없는 경우 모두 같은 `Write job not found.` 오류를 반환한다. 비관리자에게 다른 사용자의 작업 존재 여부를 드러내지 않기 위한 동작이다. 이 소유자 제한은 상태 조회에 적용되며, 저장 완료된 위키 지식은 모든 위키 독자에게 공유된다.

### 쓰기 입력

클라이언트 LLM은 완성된 저장소 편집 결과가 아니라 자연어 지시나 원문을 `write`에 보낸다. Luna가 관련 지식을 찾고 기존 노트를 확장할지 새 노트를 만들지 결정한다. 예를 들어 기존 지식에 덧붙일 내용을 제출해도 클라이언트가 대상 노트와 편집 방식을 미리 확정할 필요는 없다. 작업 워크트리부터 반영 완료까지의 절차는 [쓰기 흐름](write-flow.md)을 따른다.

`write` 응답의 `jobId`를 보관하고 `get_write_status`를 반복 호출해 완료를 확인한다. `queued`는 대기, `running`은 작성 중, `merging`은 `main` 반영 중이며, `succeeded`와 `failed`가 종료 상태다. `succeeded`를 확인하기 전에는 저장되었다고 말하지 않는다. `failed`이면 반환된 `error`를 확인한다. 이 과정은 SSE 알림이나 세션 유지 없이 별도 상태 조회로 이루어진다.

### 서버 지침과 개인정보 경계

서버는 MCP 초기화 결과의 `instructions`로 클라이언트 LLM에 다음 사용 지침을 전달한다.

- 기존 결정, 절차, 도메인 지식이 답변에 도움이 될 때 먼저 검색하고, 관련 노트 전체를 읽은 뒤 활용한다. 진입점을 찾을 때는 접두사 없이 `list_notes`를 호출해 `index.md`도 확인한다.
- 명시적인 저장 요청을 기다리지 않고, 재사용할 수 있는 발견, 결정, 절차, 원문 자료 같은 장기 지식을 선제적으로 `write`에 제출한다. 노트에 통합하는 방식은 Luna에 맡기며, 쓰기 권한과 비동기 완료 확인 절차를 따른다.
- 비밀, 자격 증명, 토큰, 개인정보를 저장하지 않는다. 실시간 채팅 상태, 임시 대화 문맥, 일시적인 작업 진행 상황도 저장하지 않는다. 모든 위키 독자에게 공유해도 되는 지속적인 지식만 제출한다.

이는 클라이언트 LLM에 전달하는 지침이지 서버의 자동 내용 검열이나 민감정보 삭제 기능이 아니다. `write`는 역할과 비어 있지 않은 입력을 검사하지만, 입력에서 비밀이나 개인정보를 자동으로 탐지·제거하지 않는다. 클라이언트는 제출 전에 이 경계를 지켜야 한다.

## 관련 문서

- [인증과 권한](auth.md)은 MCP 로그인과 엔진 토큰 발급을 설명한다.
- [설치형 Skills](skills.md)는 클라이언트별 MCP 연결과 사용 지침을 설명한다.
- [쓰기 흐름](write-flow.md)은 제출한 지식을 Luna가 반영하는 절차를 설명한다.
- [지식 저장소](knowledge-repository.md)는 노트와 색인의 배치를 설명한다.
- [RAG](rag.md)는 검색 구현과 활용 방식을 설명한다.
