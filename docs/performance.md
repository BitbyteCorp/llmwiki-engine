# 읽기 성능과 캐시 경계
읽기 경로는 SQLite 인덱스, 불변 git 객체 캐시, 조건부 HTTP 응답과 지연 렌더링으로 반복 작업을 줄이되 현재 접근 권한을 다시 확인한다.

## 배경
엔진은 API와 웹을 한 Node 프로세스에서 제공한다. 같은 노트·이력·그래프를 여러 화면과 사용자가 조회하므로 조회마다 SQL 정렬, git 하위 프로세스 실행, JSON 전송과 마크다운 파싱을 반복하면 다른 요청도 영향을 받는다. 캐시의 기준은 사용자 응답이 아니라 불변 원천 또는 명시적인 파생 인덱스 버전이다. 사용자 권한은 원천의 불변성과 별개로 바뀌므로 재사용할 데이터와 요청마다 적용할 정책을 구분한다.

## 내용
### SQLite 설정과 읽기 인덱스
`src/db/index.ts`는 연결을 열 때 다음 pragma를 명시한다. 데이터베이스 선택 이유는 [아키텍처](architecture.md#db-선택)에 기록한다.

| 설정 | 값과 의미 |
| --- | --- |
| `journal_mode` | `WAL`로 설정한다. |
| `synchronous` | `NORMAL`로 설정한다. |
| `busy_timeout` | 잠긴 DB를 최대 `5000`밀리초 기다린다. |
| `cache_size` | `-32768`로 설정해 페이지 캐시 예산을 32 MiB로 지정한다. |
| `mmap_size` | `268435456`으로 설정해 파일 매핑의 상한을 256 MiB로 지정한다. 즉시 256 MiB를 할당한다는 뜻이 아니다. |
| `temp_store` | `MEMORY`로 설정한다. |
| `foreign_keys` | `ON`으로 설정해 외래 키를 검사한다. |

`015_read_paths.sql`은 반복 조회의 스캔·정렬을 줄이는 다음 인덱스를 추가한다. 기존 사용자별 인덱스만으로는 전체 작업·가져오기 이력을 시간순으로 조회하는 경로를 충분히 지원하지 못한다.

| 인덱스 | 읽기 경로와 이유 |
| --- | --- |
| `messages_conversation_order` | `messages(conversation_id)`로 대화 메시지를 찾는다. 같은 대화 안에서 암묵적 `rowid` 순서가 삽입 순서를 제공한다. |
| `generations_assistant` | `generations(conversation_id, assistant_message_id)`로 메시지별 생성 작업을 묶거나 최신 행을 찾는다. |
| `chunks_catalog` | `ordinal=0`인 첫 청크만 대상으로 `ordinal,path,title,tags_json`을 담는 부분 covering 인덱스다. 노트 목록 조회에 본문 청크를 모두 읽지 않는다. |
| `write_jobs_created` | `write_jobs(created_at DESC,id DESC)`로 전체 작업 이력의 정렬을 지원한다. |
| `imports_created` | `imports(created_at DESC,id DESC)`로 전체 가져오기 이력의 정렬을 지원한다. |

대화 저장소는 구성원 확인, 목록·검색 발췌, 메시지 목록·단건 조회의 prepared statement를 재사용한다. assistant 메시지의 `generationId`는 **같은 대화·같은 assistant 메시지에 연결된 생성 작업 중 최대 `rowid`**의 ID다. 생성 시각이나 성공 여부로 최신 작업을 고르지 않으므로 나중에 삽입된 실패 작업도 선택된다. 메시지 목록은 각 메시지마다 생성 작업을 다시 조회하지 않고 대화의 생성 작업을 한 번 그룹화한 뒤 조인하며 메시지는 삽입 순서로 반환한다. 대화 API와 스트림 계약은 [웹](web.md#rest-api와-저장-규칙)에 기록한다.

### git 파생 데이터 캐시
`KnowledgeRepo`는 저장소 인스턴스별로 ACL 적용 전 git 파생 데이터만 보관한다. 사용자별 응답과 활동 조회의 권한 투영을 캐시하지 않는다. 트리·이력·blame·커밋 메타데이터는 확정된 커밋 SHA를 기준으로 하며, 이력·blame에는 경로와 조회 옵션도 키에 포함한다. 변경 경로는 두 SHA의 쌍, 노트 문자열 본문은 blob OID를 키로 사용한다. raw 바이너리 바이트 자체는 본문 캐시에 넣지 않는다.

`main`·태그 등 가변 ref는 요청마다 커밋 SHA로 다시 확정하고 동일 ref의 진행 중 조회만 합친다. 확정된 객체로 캐시를 찾으므로 main 전진·되감기와 외부 ref 변경을 이벤트 기반 캐시 삭제에 의존하지 않는다. 검증된 전체 SHA는 최대 4096개를 유지해 내부에서 같은 SHA를 다시 `rev-parse`하는 비용을 줄인다. 동일 키의 파생 조회도 진행 중에는 합치며 실패 결과는 보관하지 않는다.

완료된 캐시는 최근 사용 순서인 LRU로 제한하며 항목 수와 추정 바이트 예산을 모두 적용한다. 바이트 예산은 JavaScript 객체의 정확한 힙 사용량 측정값이 아니다. 예산을 넘는 단일 결과는 응답하되 캐시에 보관하지 않는다.

| 데이터 | 최대 항목 수 | 추정 바이트 예산 |
| --- | --- | --- |
| 트리 | 16 | 16 MiB |
| 노트 문자열 본문 | 256 | 16 MiB |
| 이력 | 128 | 16 MiB |
| blame | 128 | 8 MiB |
| 변경 경로 | 1024 | 8 MiB |
| 커밋 메타데이터 | 1024 | 4 MiB |

반환 배열과 커밋의 parents·trailers, blame 범위, 변경 경로 객체는 소비자별로 복사한다. 호출자의 수정이나 ACL 가림이 다음 사용자 응답으로 전파되지 않게 하는 경계다. 링크·그래프의 별도 파생 스냅샷과 요청별 정책 적용은 [RAG의 catalog 캐시](rag.md#catalog-스냅샷과-요청별-접근-투영)에 기록한다.

### HTTP 전송과 조건부 캐시
공용 HTTP 설정은 압축 가능한 JSON 응답 중 1024바이트 이상에 `compression` 미들웨어와 zlib `Z_BEST_SPEED`를 적용한다. 일반 JSON 및 `+json` 콘텐츠 유형만 대상으로 하며 클라이언트의 압축 협상과 미들웨어의 기본 필터도 따른다. `/api/events`와 `/api/generations/:id/events`는 응답 콘텐츠 유형을 설정하기 전부터 경로로 제외한다. `text/event-stream`도 JSON 필터 대상이 아니므로 스트림이 압축 때문에 묶여 전달되지 않는다. 직접 의존성은 `compression`과 개발용 `@types/compression`으로 선언한다. SSE 프레임 재사용과 화면 조회 갱신은 [실시간 이벤트](events.md)에 기록한다.

`GET /api/notes/content`와 `GET /api/notes/raw`의 캐시는 요청에 **전체 40자리 커밋 SHA를 `ref`로 명시했는지**에 따라 구분한다.

| 요청 ref | 응답 정책 |
| --- | --- |
| 전체 40자리 SHA | `Cache-Control: private, no-cache`, `Vary: Cookie, Authorization`, 응답 내용의 SHA-256으로 만든 강한 ETag를 사용한다. |
| 생략·`main`·가변 ref·짧은 SHA | `Cache-Control: private, no-store`를 사용한다. |

SHA 고정 응답도 인증과 현재 폴더 ACL을 먼저 확인한 뒤 조건부 일치를 판단한다. 유효한 재검증의 ETag가 일치하면 `304`와 빈 본문을 반환하지만 권한이 철회되면 기존 ETag가 있어도 읽기를 거부한다. 불변 바이트라고 장기 `max-age`나 `immutable`을 주지 않는 이유다. 공유 캐시에 사용자 응답을 저장해서도 안 된다.

이 정책과 Next의 공개 정적 자산 정책은 다르다. Next는 파일명에 해시가 들어간 실제 불변 자산에 `public, max-age=31536000, immutable`을 자동 적용한다. Next 16.4의 [headers 문서](https://nextjs.org/docs/app/api-reference/config/next-config-js/headers#cache-control)는 이 헤더를 `next.config`에서 덮어쓸 수 없다고 명시한다. 이 정책을 지식 노트나 모든 개발 자산으로 확대하지 않는다.

### 프런트엔드 읽기 비용
`web/next.config.ts`의 `experimental.optimizePackageImports`는 `@base-ui/react`, `@tanstack/react-query`와 CodeMirror의 `state`, `view`, `language`, `autocomplete`, `language-data` 패키지를 대상으로 한다. 큰 named-export 진입점에서 실제 사용하는 모듈을 가져오도록 하는 설정이다. `lucide-react`는 Next의 [기본 최적화 대상](https://nextjs.org/docs/app/api-reference/config/next-config-js/optimizePackageImports)이므로 중복 추가하지 않는다. 이 설정만으로 번들 감소를 보장하지 않으며 로컬 개발 서버 측정에서는 감소를 확인하지 못했다.

- 노트 Reader는 편집기를 열 때 CodeMirror 구현을 `next/dynamic`의 client-only 경계에서 불러온다. fenced 코드 언어는 `@codemirror/language-data`의 언어 설명과 lazy parser 로더를 사용해 필요한 파서를 불러온다.
- 공유 Markdown은 컴포넌트와 파싱된 subtree를 메모이제이션한다. 내용·노트 경로·revision·navigation과 fragment 동작을 의존성으로 유지하므로 사이드바·작업 공간의 재렌더링이 같은 마크다운 파싱을 반복하지 않으면서 상대 링크·이미지 주소의 변경은 반영한다.
- 이력의 `DiffView`·`RevertDialog`와 일기의 Markdown은 동적 import 경계로 분리한다. 그래프 뷰는 편집기 탭 안에서 client-only dynamic import로 불러온다.
- Mermaid 컴포넌트와 엔진은 client-only lazy import로 불러온다. 전역 테마 설정이 다이어그램 사이에 섞이지 않도록 초기화와 렌더링을 직렬화한다. 보안 경계는 [웹의 노트 렌더링](web.md#노트-렌더링과-링크)에 기록한다.
- 테마 변경 시 CodeMirror의 CSS 토큰 기반 `EditorView.theme`·`HighlightStyle`을 재구성하되 편집기 인스턴스와 초안은 유지한다. 이 구문 스타일의 직접 의존성으로 `@codemirror/language: ^6.12.4`와 `@lezer/highlight: ^1.2.5`를 선언한다.
- Mermaid와 canvas 그래프는 계산된 CSS 테마 토큰을 읽어 테마 변경 시 다시 그리거나 색을 갱신한다. 마크다운 subtree의 재사용이 독립적인 테마 갱신까지 막지는 않는다. 토큰의 디자인 의미와 화면 구성은 [웹](web.md)에 기록한다.

TanStack Query의 기본값과 이벤트 기반 갱신 범위는 [실시간 이벤트](events.md#웹-조회-캐시와-배치-갱신)가 소유한다. 이 렌더링 최적화는 API 결과를 장기간 신뢰하거나 권한 검사를 생략하는 근거가 아니다.

### 측정의 해석
성능 작업의 HTTP·전송 측정은 임시 데이터 디렉터리의 1503개 노트·6014개 청크 복사본과 독립된 Next 개발 출력에서 수행한 로컬 관찰이다. 일부 경로의 꼬리 지연과 작은 응답은 개선되지 않았다. 이 수치로 운영 지연, 동시 사용자 수 또는 production 번들 크기를 보장하지 않는다. 실행 환경·데이터 규모·인증·캐시 온도·개발/운영 모드를 구분해 해석한다. 병렬 개발 서버와 터미널 출력의 함정은 [개발 환경](development.md#개발-서버-출력과-병렬-실행)에 기록한다.

## 관련 문서
- [아키텍처](architecture.md)는 단일 프로세스와 데이터베이스 선택 이유를 설명한다.
- [RAG](rag.md)는 파생 인덱스의 버전과 catalog의 요청별 접근 투영을 설명한다.
- [실시간 이벤트](events.md)는 SSE 전송과 조회 캐시의 갱신 계약을 설명한다.
- [웹](web.md)은 편집·이력·그래프와 테마의 사용자 인터페이스를 설명한다.
- [개발 환경](development.md)은 실행 명령과 측정 환경을 분리할 때의 함정을 설명한다.
- [폴더별 접근 제어](access-control.md)는 현재 사용자에게 적용하는 읽기·쓰기 정책을 설명한다.
