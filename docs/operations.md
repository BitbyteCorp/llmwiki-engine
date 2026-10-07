# 운영 상태와 관측
엔진은 생존 확인, 준비 상태, 보호된 Prometheus 지표, 요청 로그와 운영 이력을 서로 다른 접점으로 제공한다.

## 배경
프로세스가 HTTP에 응답하는 것과 지식 저장소·검색 인덱스를 사용할 준비가 된 것은 다르다. 생존 확인을 외부 API나 인덱싱 실패에 묶으면 불필요한 재시작이 발생하므로 `/healthz`와 `/readyz`를 구분한다. 운영 지표는 사용자 작업 내용을 담지 않으며 공개 접근을 허용하지 않는다.

## 내용
### 생존과 준비 상태
- `GET /healthz`는 기존과 같이 `200 {"ok":true}`를 반환한다. 로그인 없이 호출할 수 있다.
- `GET /readyz`는 SQLite의 `SELECT 1`, 지식 저장소 `main` HEAD 조회, 최초 인덱싱 완료 상태, 비동기 인덱서 상태의 `lastError`를 확인한다.
- 최초 인덱싱이 `pending` 또는 `error`이거나 DB·git·인덱서 확인이 실패하면 `503`을 반환한다. 모두 통과해야 `200`이다.
- 성공 응답은 `{ ok: true, initialIndex: "ready", checks: { database, repository, index } }`다. 실패 응답은 공통 오류 형식인 `{ error: { code: "service_unavailable", message: "Internal server error" } }`이며 내부 확인 결과·오류 문자열·파일 경로를 포함하지 않는다.
- 최초 인덱싱 성공은 `initialIndex: "ready"`, 실패는 `"error"`로 기록하고 실패 로그를 남긴다. 최초 실패 후에는 원인을 해결하고 엔진을 재시작한다. 최초 준비 이후 발생한 인덱서 오류는 정상 동기화로 해소되면 준비 상태도 회복된다.
- 임베딩 API 키가 없는 키워드 검색 모드는 그 자체로 준비 실패가 아니다. 최초 동기화 중에는 준비되지 않았지만 이후 증분 동기화가 진행 중이라는 이유만으로 준비 상태를 내리지 않는다.

컨테이너 생존 확인에는 `/healthz`를 쓰고 트래픽 수신 전 확인에는 `/readyz`를 쓴다. 두 경로와 `/metrics`는 Next 화면이 아니라 Nest 컨트롤러가 처리한다.

### Prometheus 접근과 지표
`GET /metrics`는 관리자 웹 세션 또는 `Authorization: Bearer <METRICS_TOKEN>`만 허용한다. 일반 사용자 세션은 `403`, 미인증·잘못된 bearer는 `401`이다. REST API 토큰이나 MCP OAuth 토큰은 지표 인증 수단이 아니다. `METRICS_TOKEN`을 설정하지 않으면 bearer 인증은 비활성화되며 관리자 세션은 계속 사용할 수 있다. bearer가 있는 요청은 관리자 쿠키가 함께 있어도 해당 bearer가 유효해야 한다. 토큰은 SHA-256의 고정 길이 digest를 constant-time 비교한다.

수집기는 비밀 저장소에서 전달한 별도 토큰을 쓰며 TLS 주소를 수집 대상으로 지정한다. `/metrics` 응답은 Prometheus text 형식이고 `Cache-Control: no-store`를 사용한다.

| 지표 | 의미 |
|---|---|
| `llmwiki_http_requests_total{method,route,status}` | 응답 종료까지 완료된 HTTP 요청 수다. |
| `llmwiki_http_request_duration_seconds{method,route,status}` | 응답 종료까지 걸린 초 단위 히스토그램이다. SSE는 연결 전체 수명이므로 일반 API 지연과 구분해서 해석한다. |
| `llmwiki_write_queue_depth{status}` | DB에 기록된 `queued`, `running`, `merging` 작업 수다. |
| `llmwiki_write_jobs_total{result}` | DB에 보존된 `succeeded`, `failed` 작업 수다. |
| `llmwiki_dream_runs_total{result}` | DB에 보존된 `succeeded`, `failed` dreaming 실행 수다. |
| `llmwiki_dream_duration_seconds{result}` | 완료된 dreaming의 시작부터 종료까지 걸린 초 단위 히스토그램이다. |
| `llmwiki_index_stale` | 인덱싱된 SHA가 없거나 현재 HEAD와 다르면 1, 같으면 0이다. |
| `llmwiki_index_lag_seconds` | SHA가 다를 때 마지막 동기화 완료 후 경과한 초다. 동기화 완료 이력이 없으면 -1이고 HEAD와 같으면 0이다. 커밋 개수나 정확한 변경 대기 시간은 아니다. |
| `llmwiki_index_pending_vectors` | 임베딩을 기다리는 청크 수다. |

작업·dreaming 지표는 수집 시 DB에서 읽으므로 재시작 후에도 보존된 실행을 포함하고 반복 수집으로 중복 증가하지 않는다. 기록 삭제·DB 복원으로 값이 줄 수 있다. HTTP 지표는 프로세스 재시작 시 초기화된다. 인덱스 지표는 수집 시 비동기 `IndexerService.status()`를 기다린다.

레이블에는 HTTP 메서드, 등록된 라우트 템플릿, 상태 코드와 고정된 결과만 쓴다. 요청 ID, 사용자 ID, SHA, 노트 경로, 작업 ID, 원문 입력은 지표 레이블로 쓰지 않는다. 등록되지 않은 서버 경로는 `unmatched_backend`, Next 자산은 `next_asset`, Next 화면은 `next_page`로 묶는다.

### 요청 로그와 SSE
Next로 전달되기 전에 요청 로깅 미들웨어를 실행한다. `x-request-id`가 `[A-Za-z0-9._:-]{1,128}` 형식이면 그대로 쓰고 아니면 UUID를 발급한다. 응답의 `X-Request-ID`에도 같은 값을 넣는다.

응답이 끝나면 Pino 구조화 로그에 `{ method, route, status, ms, requestId, userId }`를 남긴다. 인증된 사용자 ID가 없으면 `userId`는 `null`이다. 원문 URL의 쿼리, 요청·응답 본문, Authorization 헤더와 쿠키를 기록하지 않는다. 요청 ID는 로그에서 문제를 연관 짓는 용도이며 지표의 레이블은 아니다.

SSE는 압축 미들웨어로 감싸지 않는다. 역방향 프록시에서도 `text/event-stream` 압축·버퍼링을 끄고 이벤트와 heartbeat가 즉시 전달되게 설정한다. 이벤트 계약과 재연결은 [실시간 이벤트](events.md)에 기록한다.

### PID와 중지 후 복원
시작 시 `DATA_DIR/server.pid`에 현재 Node 프로세스의 PID를 기록한다. 정상 종료에서는 Next 종료와 함께 PID 파일을 읽고 아직 자신의 PID가 기록되어 있을 때만 삭제한다. 다른 프로세스가 덮어쓴 PID 파일은 지우지 않는다. 강제 종료처럼 종료 훅을 실행하지 못한 경우 파일이 남을 수 있으므로 파일 존재만으로 프로세스 생존을 단정하지 않는다. 백업 복원과 중지 절차는 [백업](backup.md)에 기록한다.

### 운영 이력과 관리자 조작
로그인한 viewer 이상은 다음 읽기 API를 사용할 수 있다.

| API | 응답과 페이지 구분 |
|---|---|
| `GET /api/dreams?before=<runId>&limit=` | `{ runs, nextCursor }`다. 다음 요청의 `before`에는 반환된 실행 ID 커서를 그대로 넣는다. |
| `GET /api/dreams/:id` | dreaming 실행의 상세다. 요약, 변경 경로, 일기 경로와 push 상태를 포함한다. |
| `GET /api/backup/status` | `{ lastAttempt, lastSuccess }`다. 해당 기록이 없으면 각 값은 `null`이다. |
| `GET /api/journal` | `{ date, path, dreamRunId }` 배열이다. |
| `GET /api/activity?before=&limit=&path=&source=&type=` | `{ items, nextCursor }`다. `type`은 `commit`, `job`, `dream`, `backup`이다. |

활동은 시간, 종류, ID의 내림차순으로 정렬하고 복합 커서로 동시간 항목도 빠뜨리지 않는다. 커서는 `[at, type, id]`를 JSON으로 직렬화한 base64url 문자열이지만 클라이언트는 직접 조립하지 않고 `nextCursor`를 그대로 사용한다. 다른 사용자의 작업은 공개 요약·상태만 노출하고 원문 `input`과 `error`는 소유자 또는 관리자에게만 제공한다.

목록의 `limit` 기본값은 50이며 1~100을 허용한다. 활동의 `source` 필터는 `git`, `mcp`, `web`, `chat`, `dreaming`, `import`, `revert` 중 하나다. `path`는 저장소 상대 파일 경로이며 마크다운뿐 아니라 `assets/` 파일도 허용한다. 절대 경로, 상위 디렉터리 이동, `.git` 내부 경로는 허용하지 않는다.

관리자는 `GET /api/admin/ops`에서 큐·실패 작업·인덱스·dreaming·백업 상태를 함께 조회한다. `POST /api/admin/dreams/run`, `POST /api/admin/jobs/:id/retry`, `POST /api/admin/jobs/:id/cancel`, `POST /api/admin/index/reindex`는 수동 실행, 재시도, 대기 작업 취소와 인덱싱을 수행하며 성공·실패 결과를 감사 기록으로 남긴다. 인덱싱 본문의 `{ "full": true }`는 전체 재구축을 요청한다.

### Slack 완료 알림
`SLACK_WEBHOOK_URL`을 설정하면 dreaming의 최종 결과를 DB에 저장한 뒤 성공·실패 알림을 보낸다. 알림은 실행 상태, 실행 시간, 머지 SHA와 push 결과만 담으며 노트·일기 본문이나 사용자 입력을 보내지 않는다. 전송 실패는 경고 로그를 남길 뿐 저장된 실행 결과를 바꾸지 않는다. 전송 시간 제한과 민감한 필드 제외 정책은 [dreaming의 Slack 완료 알림](dreaming.md#slack-완료-알림)에 기록한다.

## 관련 문서
- [dreaming](dreaming.md)은 실행 상태와 push 백업의 계약을 설명한다.
- [RAG](rag.md)는 인덱스 상태와 재구축을 설명한다.
- [인증](auth.md)은 웹 세션과 관리자 권한을 설명한다.
- [실시간 이벤트](events.md)는 SSE 전달과 재연결을 설명한다.
- [백업](backup.md)은 중지 후 복원 절차를 설명한다.
