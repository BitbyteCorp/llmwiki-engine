# 웹 버전
웹은 지식 저장소의 위키 탐색·읽기와 근거를 제시하는 질의응답을 제공한다.

## 배경

사용자는 MCP 클라이언트 없이도 브라우저에서 지식을 읽고 바로 질문할 수 있어야 한다. 웹은 같은 지식 저장소를 사람이 직접 탐색하거나 질문으로 활용하는 접점이다.

## 내용

### 위키 탐색과 읽기

웹에서 위키를 탐색하고 노트를 읽는다. 지식 저장소의 노트와 진입점 색인 구조는 [지식 저장소](knowledge-repository.md)를 따른다. 예를 들어 사용자는 직접 관련 노트를 찾아 읽거나, 아래 질의응답을 통해 질문에 필요한 지식을 찾는다.

### 질의응답

사용자는 웹에서 지식에 대한 질문을 입력한다. Luna는 에이전트형 RAG를 사용해 답변하고 근거 노트를 인용한다. 검색과 노트 읽기를 반복하는 동작은 [RAG](rag.md)에, 메모리 파일의 문맥 주입 규칙은 [지식 저장소](knowledge-repository.md)에 기록한다. 인용은 사용자가 답변의 근거 노트로 돌아가 내용을 확인할 수 있도록 하기 위한 것이다.

### 대화 기록과 학습

웹 질의응답 대화 기록은 DB에 저장하며 기본적으로 생성자만 접근한다. 소유자가 편집자나 조회자를 초대하면 해당 대화 구성원에게만 공유한다. 관리자라도 구성원이 아니면 대화와 생성 작업에 접근하지 못한다.

대화에서 지식으로 추출하는 대상은 사용자가 말한 사실과 정정뿐이다. Luna의 답변은 기존 위키에서 나온 지식을 다시 넣어 지식이 순환하게 만들 수 있으므로 학습 대상에서 제외한다.

반영은 [dreaming](dreaming.md#실행-시각과-입력)에서 하루치를 모아 배치로 수행한다. 대화에서 추출한 지식은 공용 지식 저장소에 들어가므로, 대화 기록과 달리 지식 저장소에 접근하는 모든 사용자가 볼 수 있다.

### 변경 이력

웹에서 노트별 변경 이력과 쓰기 작업별 변경 이력을 제공한다. 쓰기 작업별로 누가 요청했는지와 무엇이 바뀌었는지(diff)를 볼 수 있어야 한다.

이력의 원천은 지식 저장소의 git 커밋과 DB의 쓰기 작업 기록이다. 커밋의 요청자·수행자 기록 규칙은 [쓰기 흐름](write-flow.md#요청자와-커밋-수행자의-구분)을 따른다. 잘못된 지식을 고치는 절차는 [정정 쓰기](write-flow.md#잘못된-지식의-정정)에 설명한다.

### 로그인과 관리 화면

웹은 로그인과 관리자용 관리 화면을 제공한다. 관리 화면에서 바꾸는 사용자·권한 설정과 첫 관리자 등록 절차는 [인증과 권한](auth.md)을 따른다.

### 디자인

웹은 shadcn/ui 기반으로 깔끔하게 레이아웃을 맞춘다.

`components.json` 설정은 다음과 같다.

| 설정 | 값 |
| --- | --- |
| `style` | `base-nova` |
| `baseColor` | `neutral` |
| `cssVariables` | 사용한다. |
| `iconLibrary` | `lucide` |
| `menuColor` | `default` |
| `menuAccent` | `subtle` |

엔진 웹은 Next.js 16, React 19, Tailwind CSS 4, `@base-ui/react`를 사용한다. App Router가 화면 경로와 공통 레이아웃을 관리하며 Nest 서버가 같은 Node 프로세스 안에서 Next의 요청 핸들러를 호출한다. 별도 Next 서버 프로세스나 컨테이너를 두지 않는 이유와 서버 경로 분리는 [전체 구성](architecture.md)에 기록한다.

### 구현된 웹 화면

`web/`는 별도 패키지가 아닌 단일 루트 패키지 안의 Next 프로젝트 디렉터리다. UI 의존성은 루트에서 설치하며 `pnpm exec next build web`로 `web/.next`에 빌드한다. 평소 개발과 실행은 Nest와 Next를 한 프로세스로 묶는 루트 스크립트를 사용하며 명령은 [개발 환경](development.md)에 기록한다. 클라이언트 화면은 같은 origin의 `/api`와 `/auth`를 사용하므로 별도 개발 프록시가 필요하지 않다.

화면은 React 19, Next.js App Router, TanStack Query, Tailwind CSS 4로 구성한다. `web/app`은 라우트와 레이아웃, `web/pages-ui`는 클라이언트 화면, `web/components`와 `web/lib`는 공통 UI와 API·스트림 처리를 담당한다. 최상위 레이아웃에 서버 상태 캐시 제공자를 두고 콘솔 레이아웃에서 로그인과 관리자 접근을 확인한다. 흰 배경, 중립색, 얇은 테두리, 그림자 없는 패널, LINE Seed Sans KR와 Geist Mono 글꼴을 사용한다. 왼쪽 사이드바에 위키·검색·질문하기·변경 이력을 배치하고 관리자에게만 관리 메뉴를 표시한다. 모바일에서는 메뉴 버튼으로 사이드바를 열고 닫는다. 헤더의 사용자 메뉴에서 현재 계정과 역할을 확인하고 로그아웃한다.

`/api/me`가 401을 반환하면 Google 로그인 화면을 표시한다. `/login`에서도 같은 로그인 화면을 직접 열 수 있다. 로그인 버튼은 `/auth/google/login`으로 이동하며, 로그인 후 돌아갈 앱 경로를 `next`에 전달한다. 다른 API에서 세션 만료를 받으면 캐시를 지우고 로그인 화면으로 전환한다.

위키 화면은 폴더별 파일 트리와 선택한 노트의 본문을 표시한다. 노트 경로는 `/wiki/[...path]`로 유지하며 각 경로 조각을 URL 인코딩한다. `/wiki`로 들어오면 `index.md`를 우선 선택한다. GFM 표·목록·코드 블록을 렌더링하고 frontmatter의 태그·수정 날짜·중요도를 작은 배지로 표시한다. `[[name]]`과 `[[name|alias]]`는 이름 해석 API로 찾은 노트에 연결하며, 코드 안의 같은 문자열은 링크로 바꾸지 않는다. 존재하지 않는 위키 링크는 본문에 남겨 표시하며, 상대 경로의 마크다운 노트 링크도 앱 안에서 연다. 노트에서 해당 경로의 변경 이력으로 이동한다.

현재 Next.js 16의 클라이언트 경로 이동에서 동적 경로 매개변수는 URL 인코딩된 값으로 전달된다. 노트의 각 경로 조각과 대화·작업·커밋 식별자는 화면에서 한 번만 디코딩한 뒤 API에 넘긴다. API 클라이언트가 요청 경로를 다시 인코딩하므로 이 처리를 생략하면 한글 노트 경로가 이중 인코딩되며, 두 번 디코딩하면 파일명에 들어간 `%20` 같은 문자열이 달라진다.

검색 화면은 검색어를 URL에 유지하고 결과의 노트 경로·제목·소제목·본문 조각·관련 노트를 표시한다. 질문하기 화면은 본인의 대화 목록과 메시지·인용 노트를 표시하고 대화를 만들거나 삭제한다. 답변은 fetch 스트림으로 `delta`, `done`, `error` SSE 이벤트를 읽어 갱신한다. 답변 생성 중에는 중지 버튼을 제공하고 대화 삭제를 막는다. 실패하거나 중지한 답변 조각은 완료되지 않은 답변으로 표시하며 서버에 저장된 완성 답변과 구분한다.

변경 이력 화면 `/history`는 전체 또는 노트별 커밋과 쓰기 작업 목록을 표시한다. 커밋 상세 `/history/commits/[sha]`에서 요청자인 작성자, 연결된 쓰기 작업, 변경 파일, 추가·삭제 줄을 구분한 unified diff를 확인한다. 쓰기 작업 상세 `/jobs/[id]`에서 상태·요청자·입력·요약·오류·시각·관련 커밋을 확인한다. 관리 화면 `/admin`은 사용자 추가·역할 변경·삭제와 등록 이메일 제한·허용 도메인 설정을 제공한다. 마지막 관리자 보호와 같은 서버 오류는 화면에 표시하며, 관리자가 아닌 계정으로 직접 관리 경로에 들어오면 접근 오류를 표시한다.

### REST API와 저장 규칙

웹 API는 `/api` 아래에 있으며 모든 요청에 웹 세션이 필요하다. `viewer`도 위키·검색·이력·질의응답을 이용할 수 있고, `/api/admin`은 `admin`만 이용할 수 있다. 오류는 HTTP 상태와 함께 `{error:{code,message}}` 형태로 반환한다. 마지막 관리자를 삭제하거나 다른 역할로 내리려 하면 `409`와 `last_admin` 코드를 반환한다.

`src/api/api.module.ts`는 `MeController`, `NotesController`, `SearchController`, `HistoryController`, `JobsController`, `ConversationsController`, `AdminController`를 등록한다. 각 컨트롤러는 `SessionGuard`와 `RolesGuard`로 보호하며 관리 컨트롤러에는 `@Roles('admin')`을 적용한다. 입력은 `api.dto.ts`의 Zod 스키마와 공용 `ZodValidationPipe`로 검증하고 오류 응답은 전역 HTTP 예외 필터가 만든다. `NotesService`는 노트 읽기와 이름 해석을, `HistoryService`는 git 이력과 쓰기 작업 연결·요청자 표시를 담당한다.

| 접점 | 용도 |
| --- | --- |
| `GET /me` | 현재 사용자를 반환한다. |
| `GET /notes/tree`, `/notes/content?path=`, `/notes/resolve?name=` | main의 마크다운 목록, 원문·frontmatter·본문·`updatedSha`, 위키 링크의 노트 경로를 반환한다. |
| `GET /search?q=&limit=` | 검색 결과를 반환한다. |
| `GET /history?path=&limit=&before=`, `/commits/:sha` | 전체 또는 노트별 커밋 목록과 커밋·파일 변경·patch·연결된 쓰기 작업을 반환한다. |
| `GET /jobs?mine=1&limit=&before=`, `/jobs/:id` | 요청자 이메일·이름을 포함한 쓰기 작업 목록과 작업별 커밋을 반환한다. |
| `GET /conversations?q=`, `POST /conversations`, `GET`, `PATCH`, `DELETE /conversations/:id` | 구성원 대화의 검색·생성·조회·제목 변경·소유자 삭제를 처리한다. |
| `POST /conversations/:id/messages`, `PATCH /conversations/:id/messages/:mid`, `POST .../:mid/retry`, `POST .../:mid/regenerate` | 질문 제출·수정·재시도·답변 재생성을 SSE로 전달한다. |
| `GET /generations/:id/events`, `POST /generations/:id/cancel` | 생성 이벤트 재연결과 명시적인 중지를 처리한다. |
| `GET`, `POST /conversations/:id/members`, `DELETE /conversations/:id/members/:userId`, `POST /conversations/:id/presence` | 구성원과 30초 TTL 접속 상태를 관리한다. |
| `POST /uploads`, `GET /uploads/:id`, `POST /uploads/:id/save` | 첨부 업로드·소유자 다운로드·assets 저장을 처리한다. |
| `POST /conversations/:id/messages/:mid/proposal` | 답변에서 새 노트나 수정 초안을 만들며 저장하지 않는다. |
| `/admin/users`, `/admin/settings` | 사용자와 역할, 허용 목록 사용 여부와 허용 도메인 설정을 관리한다. |

표의 경로 앞에는 `/api`를 붙인다. 노트 내용은 main의 HEAD를 먼저 고정한 뒤 같은 커밋에서 읽으므로, `updatedSha`는 본문과 일치하는 저장소 스냅샷이다. `path`는 저장소 상대 `.md` 경로이며 절대 경로·상위 경로·git 메타데이터 경로는 거절한다. 위키 링크는 확장자를 제외한 파일의 마지막 이름으로 대소문자를 구분하지 않고 찾는다. 같은 이름이 여러 폴더에 있으면 경로를 정렬해 첫 번째 노트를 선택한다.

목록의 `limit`은 기본 50, 최대 100이다. 변경 이력의 `before`는 마지막 커밋 SHA이며 해당 커밋보다 오래된 결과를 요청한다. 쓰기 작업의 `before`는 마지막 작업의 `createdAt`인 UTC ISO 시각이다. 커밋과 쓰기 작업은 작업의 `commits` 배열 또는 `mergeSha`로 연결한다. 요청자가 삭제되어도 쓰기 작업 이력은 남으며 요청자 표시는 이메일 대신 `deleted user`, 이름 대신 `null`을 반환한다.

대화는 `conversations`, 메시지는 `messages`, 구성원은 `conversation_members`, 생성 작업은 `generations`, 순서가 있는 SSE 프레임은 `generation_frames`에 저장한다. 대화 목록은 최근 활동 순서이며 `q`는 제목과 메시지의 부분 문자열을 검색해 최대 240자 `snippet`을 추가한다. 메시지는 삽입 순서다. 구성원이 아닌 사용자의 요청은 관리자도 `404`, 대화 조회자의 변경 요청은 `403`이다. 소유자만 대화 삭제와 구성원 변경을 수행하며 자기 소유권을 제거할 수 없다. 구성원 편집자는 제목·메시지를 변경한다. 전역 `viewer`도 자신이 만든 대화의 소유자로 질문할 수 있다.

제목 없이 만든 대화는 첫 질문의 공백을 정리하고 Unicode 문자 80개까지 잘라 제목을 정한다. 명시적 제목은 200자, 질문은 100,000자이며 빈 질문은 거절한다. `PATCH /conversations/:id` 입력은 `{title}`이다. `GET /conversations/:id`는 `{conversation,messages}`이며 메시지는 `{id,role,content,citations,attachments,context,status,usage,model,effort,createdAt}`이다. `status`는 `completed|running|failed|cancelled|interrupted`, `usage`는 `{inputTokens,outputTokens,reasoningTokens}|null`, `context`는 `{notePath,ref?,selection?}|null`이다. `citations`는 `{path,heading?,anchor?,excerpt?,sha?}` 객체 배열이다.

`POST /conversations/:id/messages` 입력은 `{content,attachments?:string[],context?:{notePath,ref?,selection?},clientId?,model?,effort?}`이다. 첨부는 최대 10개이며 업로드 소유자만 새 질문에 첨부한다. 이전 구성원이 제출한 첨부는 권한을 검사한 대화 기록을 통해 서버에서 다시 읽는다. `model`은 `LUNA_MODELS`의 허용 목록이고 미설정 시 `LUNA_MODEL`만 허용한다. `effort`는 `low|medium|high`다. 고정 노트 문맥은 서버가 지정 ref의 정식 원문을 읽으며 selection은 신뢰하지 않는 인용문으로 다룬다.

SSE는 `id: <정수 seq>`, `event: <유형>`, `data: <JSON>` 뒤 빈 줄을 보낸다. 이벤트는 `generation {generationId,userMessageId}`, `status {phase}`, `tool {name,state:'start'|'end',summary,path?}`, `citation {path,heading?,anchor?,excerpt?,sha?}`, `delta {text}`, `usage {inputTokens,outputTokens,reasoningTokens}`, `done {message}`, `error {code,message}`다. 도구 요약은 검색어와 노트 경로만 포함하며 노트 본문을 포함하지 않는다. `GET /generations/:id/events`의 `Last-Event-ID`는 해당 생성의 마지막 정수 seq이며 이후 프레임만 재생하고 실시간 프레임으로 이어진다. 완료된 생성도 재생한다.

HTTP 연결 종료는 생성 작업을 중지하지 않는다. 명시적 `POST /generations/:id/cancel`만 구성원 편집자나 소유자의 생성을 중지한다. 서버 재시작 시 실행 중 작업은 `interrupted`로 전환한다. 실패·취소된 답변도 부분 텍스트와 상태를 저장한다. 공급자 오류는 내부 로그에만 남기며 사용자에게 `generation_failed` 등 안전한 코드와 메시지를 전달한다. 대화에 실행 중 생성은 하나만 허용하며 중복 실행·수정·삭제는 `409 generation_active`다.

동일 대화의 동일 `clientId` 제출은 기존 생성 이벤트를 반환하며 질문을 중복 저장하지 않는다. `POST .../messages/:mid/retry`는 실패·취소·중단된 답변이나 남아 있는 사용자 질문을 재시도한다. `POST .../:mid/regenerate`는 assistant 메시지에서 이전 질문의 답변을 새로 만든다. `PATCH .../:mid` 입력은 `{content}`이며 사용자 질문만 수정한다. 이 세 경로는 같은 SSE 형식으로 응답하고 해당 질문 뒤의 턴을 삭제하며 사용자 질문을 새로 추가하지 않는다. 저장된 과거 요약도 무효화한다. 긴 대화는 최근 턴을 원문으로 유지하고 오래된 턴을 대화별 요약으로 저장한다. 아직 학습하지 않은 사용자 질문의 `learned_at`은 `NULL`이다.

수정·재생성으로 대화에서 제거한 턴의 생성 이벤트와 `clientId` 기록도 대화가 존재하는 동안 유지한다. 늦게 재전송한 이전 질문은 기존 이벤트를 재생하며 제거한 턴을 복원하지 않는다. 생성 중 요청자가 구성원에서 제거되어도 나머지 구성원에게 완성 메시지를 전달하며, 제거된 사용자의 실시간 스트림은 종료한다. 편집한 사용자 질문은 다시 미학습 상태가 되고 dreaming은 수집한 질문 내용과 현재 내용이 같은 경우에만 학습 완료로 기록한다.

구성원 추가 입력은 `{email,role:'editor'|'viewer'}`이며 조회·추가는 `{members:[{userId,email,name,role}]}`를 반환한다. 삭제는 `204`다. presence 입력은 `{typing}`이며 `{expiresAt}`를 반환한다. 30초 동안 갱신하지 않은 사용자는 제거하며 `conversation.presence {conversationId,users:[{id,name,typing}]}`와 `conversation.updated {conversationId,messageId?}` 이벤트는 구성원 userIds에만 전달한다.

업로드 multipart 필드는 `file`, 선택 필드 `purpose=chat|import`이며 기본값은 `chat`이다. chat은 20 MB 이하 PNG/JPEG/WebP/GIF/PDF/UTF-8 text/Markdown이고 실제 바이트를 검사한다. import는 전역 editor 이상만 생성하며 ZIP을 추가 허용하고 100 MB 한도다. import 목적 파일은 chat 첨부로 사용할 수 없다. 응답은 `{id,userId,name,mediaType,size,createdAt,purpose}`다. 다운로드는 소유자만 가능하며 안전한 Content-Disposition과 탐지한 Content-Type을 반환한다. save 입력은 `{path,baseSha}`이고 경로는 `assets/` 아래이며 공용 NoteWriter를 통해 저장한다. 메시지에서 참조하지 않고 assets로 저장하지 않은 업로드는 `UPLOAD_RETENTION_DAYS`(기본 7일) 이후 제거한다.

proposal 입력은 `{mode:'new'|'edit',path?}`이며 edit에는 경로가 필요하다. 완성된 assistant 답변을 기반으로 `{path,baseSha,original:string|null,proposed}` 전체 노트 초안을 반환한다. 이 호출은 커밋이나 노트 쓰기를 수행하지 않는다. 클라이언트가 diff를 확인한 뒤 별도의 노트 쓰기 접점으로 적용한다.

## 관련 문서

- [지식 저장소](knowledge-repository.md)는 웹에서 읽는 위키의 구조를 설명한다.
- [RAG](rag.md)는 Luna가 근거 지식을 찾아 답변하는 방식을 설명한다.
- [인증과 권한](auth.md)은 사용자 로그인과 도메인·역할 정책을 설명한다.
- [쓰기 흐름](write-flow.md)은 요청자 추적과 잘못된 지식의 정정 절차를 설명한다.
- [dreaming](dreaming.md)은 대화에서 추출한 지식을 반영하는 배치를 설명한다.
- [전체 구성](architecture.md)은 Nest 서버가 Next 화면을 같은 프로세스에서 제공하는 배포 구성을 설명한다.
