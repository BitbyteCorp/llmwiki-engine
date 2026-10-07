# 실시간 이벤트
인증된 화면은 단일 SSE 연결로 지식, 작업, 인덱스와 대화 변경을 받아 조회 캐시를 갱신한다.

## 배경
여러 사용자가 같은 지식 저장소를 수정하면 정적 조회만으로 화면이 최신 main과 어긋난다. 이벤트는 데이터를 복제하는 저장소가 아니라 변경을 알리는 신호다. 진실 원천은 git과 각 조회 API다.

## 내용
`EventsModule`은 전역 `EventsService`를 제공한다. `publish(event, audience)`와 `subscribe(listener)`를 사용하며 구독 해제 함수를 반드시 호출한다. 이벤트 종류는 다음과 같다.

- `job.updated`는 `jobId`, `userId`, `status`, 선택적 `phase`를 전달한다. 작업 소유자와 관리자만 대상으로 한다.
- `main.updated`는 `sha`, `paths`, 선택적 `jobId`를 전달한다. 인증된 모든 사용자에게 전달한다.
- `index.updated`는 `sha`와 `syncing`, `ready`, `error` 중 하나인 `status`를 전달한다.
- `dream.updated`는 `runId`와 `status`를 전달한다.
- `conversation.updated`는 `conversationId`와 선택적 `messageId`를 전달한다.
- `conversation.presence`는 `conversationId`와 `{ id, name, typing }` 사용자 배열을 전달한다. 대화 이벤트의 대상은 대화 구성원이다.

대상 `'all'`은 인증된 모든 세션을 뜻한다. `{ userIds, admins?: true }`는 지정 사용자에게만 전달하며 `admins: true`일 때 관리자도 전달받는다. 관리자가 모든 사적인 대화 이벤트를 자동으로 받는 규칙은 없다. 이벤트 페이로드에는 원문 노트나 작업 입력을 넣지 않는다.

`GET /api/events`는 인증 후 `text/event-stream`으로 응답한다. 각 변경은 `id: <seq>`, `event: <type>`, `data: <JSON>` 세 줄과 빈 줄로 구분한다. 순번은 프로세스 전체에서 단조 증가한다. 대상 필터 때문에 한 연결에서 순번이 건너뛸 수 있다. 재연결 후에도 같은 프로세스의 순번은 계속되지만 프로세스 재시작 시 초기화한다. 이 연결은 과거 이벤트를 보관하거나 `Last-Event-ID`로 재생하지 않는다.

연결 직후 `: connected` 주석을 보내고 25초마다 `: ping` 주석을 보낸다. 연결 종료 시 타이머와 구독을 제거하며 애플리케이션 종료 시 열린 스트림을 끝내 HTTP 서버의 종료를 막지 않는다. 응답은 `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`를 설정하고 헤더를 즉시 flush한다. Next custom server는 `/api`를 Nest에 전달하므로 SSE를 Next 응답 버퍼로 보내지 않는다. 외부 프록시도 SSE 경로의 버퍼링을 비활성화해야 한다.

웹의 `useLiveEvents()`는 QueryClientProvider 내부에서 한 번 실행한다. 브라우저 `EventSource`가 자동 재연결하며 두 번째 `open`부터 전체 조회 캐시를 한 번 무효화해 끊긴 동안 놓친 이벤트를 보완한다. 작업 이벤트는 작업 목록·상세, main 이벤트는 노트 트리·내용·이력·검색, 인덱스 이벤트는 검색, dreaming 이벤트는 활동·실행 기록, 대화 이벤트는 대화 조회를 무효화한다. 화면은 `onLiveEvent(type, handler)`의 반환 함수를 호출해 구독을 해제한다. `useLiveConnection()`은 `connecting`, `connected`, `disconnected` 연결 상태를 제공한다.

## 관련 문서
- [아키텍처](architecture.md)는 Nest와 Next의 라우팅을 설명한다.
- [운영](operations.md)은 요청 추적과 상태 확인을 설명한다.
- [쓰기 흐름](write-flow.md), [dreaming](dreaming.md), [RAG](rag.md)는 이벤트를 발행하는 변경 흐름을 설명한다.
