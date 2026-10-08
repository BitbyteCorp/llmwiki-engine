# 실시간 이벤트
인증된 화면은 단일 SSE 연결로 지식, 작업, 인덱스와 대화 변경을 받아 조회 캐시를 갱신한다.

## 배경
여러 사용자가 같은 지식 저장소를 수정하면 정적 조회만으로 화면이 최신 main과 어긋난다. 이벤트는 데이터를 복제하는 저장소가 아니라 변경을 알리는 신호다. 진실 원천은 git과 각 조회 API다.

## 내용
`EventsModule`은 전역 `EventsService`를 제공한다. `publish(event, audience)`와 `subscribe(listener)`를 사용하며 구독 해제 함수를 반드시 호출한다. 이벤트 종류는 다음과 같다.

- `job.updated`는 `jobId`, `userId`, `status`, 선택적 `phase`를 전달한다. 작업 소유자와 관리자만 대상으로 한다.
- `main.updated`는 `sha`, `paths`, 선택적 `jobId`를 전달한다. 구독자별로 읽을 수 있는 경로만 남기며 남은 경로가 없으면 해당 이벤트를 보내지 않는다. 관리자는 모든 경로를 받는다.
- `index.updated`는 `sha`와 `syncing`, `ready`, `error` 중 하나인 `status`를 전달한다.
- `dream.updated`는 `runId`와 `status`를 전달한다.
- `conversation.updated`는 `conversationId`와 선택적 `messageId`를 전달한다.
- `conversation.presence`는 `conversationId`와 `{ id, name, typing }` 사용자 배열을 전달한다. 대화 이벤트의 대상은 대화 구성원이다.

대상 `'all'`은 인증된 모든 세션을 뜻한다. `{ userIds, admins?: true }`는 지정 사용자에게만 전달하며 `admins: true`일 때 관리자도 전달받는다. 관리자가 모든 사적인 대화 이벤트를 자동으로 받는 규칙은 없다. 이벤트 페이로드에는 원문 노트나 작업 입력을 넣지 않는다.

경로 필터는 [폴더별 접근 제어](access-control.md)를 따른다. 같은 발행 이벤트라도 구독자마다 `paths`가 다르므로 페이로드를 공통 캐시로 다시 공유하지 않는다. `EventsService.format()`은 같은 이벤트 객체와 순번의 SSE 프레임 문자열을 재사용해 구독자마다 JSON을 다시 직렬화하는 비용을 줄이지만, `main.updated`는 사용자별로 투영한 별도 객체를 사용한다. 인덱스·꿈꾸기 상태 이벤트는 원문을 전달하지 않는 변경 신호이며 실제 조회 결과에서 다시 접근 정책을 적용한다.

`GET /api/events`는 인증 후 `text/event-stream`으로 응답한다. 각 변경은 `id: <seq>`, `event: <type>`, `data: <JSON>` 세 줄과 빈 줄로 구분한다. 순번은 프로세스 전체에서 단조 증가한다. 대상 필터 때문에 한 연결에서 순번이 건너뛸 수 있다. 재연결 후에도 같은 프로세스의 순번은 계속되지만 프로세스 재시작 시 초기화한다. 이 연결은 과거 이벤트를 보관하거나 `Last-Event-ID`로 재생하지 않는다.

연결 직후 `: connected` 주석을 보내고 25초마다 `: ping` 주석을 보낸다. 연결 종료 시 타이머와 구독을 제거하며 애플리케이션 종료 시 열린 스트림을 끝내 HTTP 서버의 종료를 막지 않는다. 응답은 `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`를 설정하고 헤더를 즉시 flush한다. Next custom server는 `/api`를 Nest에 전달하므로 SSE를 Next 응답 버퍼로 보내지 않는다. 외부 프록시도 SSE 경로의 버퍼링을 비활성화해야 한다.

### 웹 조회 캐시와 배치 갱신
웹의 `useLiveEvents()`는 QueryClientProvider 내부에서 한 번 실행한다. 공용 TanStack Query 기본값은 `staleTime: 30초`, 브라우저 `gcTime: 10분`, `refetchOnWindowFocus: false`, `structuralSharing: true`, `retry: false`다. 개별 조회는 필요한 옵션을 덮어쓸 수 있다. 브라우저 `EventSource`가 자동 재연결하며 두 번째 `open`부터 전체 조회 캐시를 한 번 무효화해 끊긴 동안 놓친 이벤트를 보완한다. 변경 스트림에 과거 이벤트 재생이 없으므로 정상 연결 중의 좁은 갱신과 재연결 복구를 구분한다.

서버 렌더링(SSR)에서는 `environmentManager.isServer()`로 판별해 `gcTime`을 TanStack 기본값인 `Infinity`로 둔다. 유한한 `gcTime`은 렌더마다 만든 조회에 GC `setTimeout`을 예약하고, Node 24의 `AsyncContextFrame`은 그 타이머에 요청의 비동기 문맥을 붙인다. 그 결과 타이머가 만료될 때까지 React 렌더 요청·응답 객체·개발 모드 디버그 스택 전체가 해제되지 않는다. 실제로 서버 기본값을 10분으로 덮어썼을 때 개발 서버의 GC 이후 힙이 SSR 요청 하나당 약 0.65MB씩 늘어 900회 요청에 139MB에서 719MB가 되었고, 여러 개발 서버가 수 GB까지 커져 호스트가 OOM에 빠졌다. 서버의 `QueryClient`는 요청마다 새로 만들어 렌더 후 버려지므로 GC 타이머가 필요 없다. 개별 조회의 `gcTime`도 SSR에서 실행되는 조회라면 같은 이유로 서버 값을 덮어쓰지 않는다.

일반 변경 이벤트의 조회 무효화는 첫 이벤트부터 고정 100밀리초 창으로 모은다. 뒤따르는 이벤트가 타이머를 다시 미루지 않으므로 지속적인 이벤트에도 flush가 실행된다. 한 번의 flush에서 쌓인 ID·경로·조회 루트를 하나의 `invalidateQueries` predicate로 처리한다. `onLiveEvent` handler는 배치를 기다리지 않고 즉시 실행하며 presence는 조회 무효화 타이머를 만들지 않는다.

| 변경 신호 | 정상 연결 중 조회 갱신 범위 |
| --- | --- |
| `job.updated` | 작업 목록·활동·운영·가져오기를 갱신하며 작업 상세는 `jobId`가 일치하는 것만 갱신한다. |
| `main.updated` | 트리·노트 이름 해석·활동·일기와 검색·링크·그래프·태그·유사도·중복을 넓게 갱신한다. 현재 노트 내용·blame과 경로별 이력은 변경된 경로만 갱신하며 전역 이력은 항상 갱신한다. |
| `index.updated` | 검색·검색 제안·유사도·링크·그래프·태그·중복과 운영 상태를 갱신한다. |
| `dream.updated` | 활동·꿈꾸기 목록·일기·백업·운영 상태를 갱신하며 실행 상세는 `runId`가 일치하는 것만 갱신한다. |
| `conversation.updated` | 대화 목록과 해당 `conversationId`의 대화·구성원 상세를 갱신한다. |
| `conversation.presence` | handler로 접속·입력 상태만 전달한다. |

운영 갱신에는 `ops-ready`도 포함한다. 링크·그래프·검색·태그 등의 넓은 갱신을 유지하는 이유는 바뀐 노트 밖의 역링크와 파생 관계도 영향을 받기 때문이다. main 변경은 전체 40자리 SHA에 고정된 노트·blame·커밋과 양쪽 ref가 모두 전체 SHA인 비교를 무효화하지 않는다. 다만 되돌리기 미리보기는 원본 SHA가 고정돼도 현재 main에 의존하므로 갱신한다.

연결 오류·재연결·언마운트에서는 예약 타이머와 pending 배치를 비운다. 조회 무효화만 수행하는 대화·작업·운영 화면의 중복 구독은 두지 않고 공용 hook이 갱신을 소유한다. mutation 성공 직후의 즉시 조회 갱신과 상태·배너·접속 handler는 유지한다. 노트 내용 조회는 현재 `['notes/content', path]`, 과거 `['notes/content', path, ref]`로 통일해 Blame에서도 별도 `['note', ...]` alias를 만들지 않는다. 화면은 `onLiveEvent(type, handler)`의 반환 함수를 호출해 구독을 해제한다. `useLiveConnection()`은 `connecting`, `connected`, `disconnected` 연결 상태를 제공한다.

## 관련 문서
- [아키텍처](architecture.md)는 Nest와 Next의 라우팅을 설명한다.
- [운영](operations.md)은 요청 추적과 상태 확인을 설명한다.
- [쓰기 흐름](write-flow.md), [꿈꾸기](dreaming.md), [RAG](rag.md)는 이벤트를 발행하는 변경 흐름을 설명한다.
- [읽기 성능과 캐시 경계](performance.md)는 JSON 압축에서 SSE를 제외하는 규칙과 HTTP·렌더링 최적화를 설명한다.
