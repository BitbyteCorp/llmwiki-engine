# llmwiki-engine

Node.js 기반으로 LLM Wiki를 관리하는 도구다.
사용자는 웹, MCP, 설치형 Skill로 지식을 읽고 쓰며, 지식은 별도 git 저장소에 마크다운으로 쌓인다.

## 이 위키를 읽는 법

- 이 파일은 프로젝트 지식의 색인이다.
- 각 항목은 짧은 요약과 `docs/` 문서 링크로 이루어진다.
- 작성 규칙은 [AGENTS.md](AGENTS.md)의 '지식 문서화' 절을 따른다.

## 용어

- **엔진**: 이 저장소가 만드는 Node.js 서비스다.
- **지식 저장소**: 엔진이 관리하는 별도 git 저장소다. 이 저장소의 `docs/`(개발 문서)와 다르다.
- **도니**: 지식을 쓰고 정리하고 답하는 엔진의 에이전트다. 모델은 `LLM_MODELS`로 고른다.
- **꿈꾸기**(dreaming): 매일 03:00(KST)에 하루치 변경을 정리하는 배치 작업이다.
- **일기**: 꿈꾸기가 날짜별로 쓰는 `journal/YYYY-MM-DD.md`다.
- **메모리 파일**: 도니의 문맥을 담는 지식 저장소 루트의 `MEMORY.md`다.
- **작업 워크트리**: 쓰기와 꿈꾸기마다 `main`에서 파생하는 git worktree다.

## 문서 색인

각 항목은 다음 형식으로 기록한다.
`- [주제](docs/topic.md) — 주제를 한두 문장으로 요약한다.`

### 구성

- [아키텍처](docs/architecture.md) — 컨테이너 하나, Node 프로세스 하나에 웹·MCP·OAuth·작업 큐·스케줄러·인덱서를 함께 띄우는 구성이다.
- [도니](docs/agent.md) — 지식 쓰기·충돌 해결·꿈꾸기·웹 질의응답을 맡는 에이전트와 모델 선택, 도구 및 임베딩의 경계를 설명한다.
- [지식 저장소](docs/knowledge-repository.md) — `main`이 진실 원천이고 GitHub는 하루 한 번 push되는 백업이며, LLM Wiki 표준을 따른 레이아웃을 쓴다.
- [개발 환경](docs/development.md) — 기술 스택·모듈 소유·스크립트·환경변수와 로컬·Docker 실행, SQL 테이블 재구축의 인덱스·트리거 보존 및 외래 키 검증을 설명한다. 터미널 출력 정지와 개발 잠금 파일의 함정, 병렬 서버의 격리 방법도 기록한다.
- [백업과 복원](docs/backup.md) — 일관된 SQLite 스냅샷과 지식 git bundle의 체크섬 검증, 오프라인 복원과 main 내보내기를 설명한다.
- [운영](docs/operations.md) — 준비 상태·요청 식별자·인증 지표와 관리자 운영 API를 설명한다. 운영 사이드바·설정·팔레트의 즉시 실행과 확인·중복 방지·결과 알림을 함께 기록한다.
- [읽기 성능](docs/performance.md) — SQLite 조회 인덱스와 Git 캐시, 인증을 유지하는 HTTP 재검증·압축, 화면의 지연 로딩을 설명한다. 캐시 수명과 권한 경계, 성능 수치의 해석 한계를 기록한다.

### 흐름

- [쓰기 흐름](docs/write-flow.md) — 작업 워크트리에서 도니가 수정·커밋하고 `main`에 직렬로 머지하며, 충돌은 도니가 푼다.
- [꿈꾸기](docs/dreaming.md) — 매일 03:00 KST에 충돌·중복을 정리하고 일기를 쓴 뒤 GitHub에 push한다.
- [작성 규칙](docs/writing-rules.md) — 도니가 지식 저장소에 쓸 때 따르는 Obsidian 기반 규칙이다.
- [RAG](docs/rag.md) — SQLite에 키워드·벡터·링크 색인을 두고 하이브리드 검색을 한다. 링크·그래프 catalog 스냅샷과 요청별 접근 권한 투영의 경계를 설명한다.
- [원문 수집](docs/ingestion.md) — URL·PDF·텍스트·Obsidian·Notion 원문을 불변 raw 소스로 보관하고 도니 통합 작업으로 연결한다.

### 접점

- [인증](docs/auth.md) — Google Workspace 로그인과, 엔진이 인가 서버가 되는 MCP OAuth다.
- [폴더별 접근 제어](docs/access-control.md) — 경로 규칙의 우선순위와 웹·MCP·검색·도니·이벤트·내보내기의 읽기·쓰기 범위, 공유 대화와 꿈꾸기의 한계를 설명한다.
- [MCP](docs/mcp.md) — 지식 도구·리소스와 stateless Streamable HTTP 전송 계약을 설명한다.
- [설치형 Skills](docs/skills.md) — Claude Code·Codex·Hermes의 설치형 지침과 설정 MCP 탭의 일곱 클라이언트 등록·OAuth·실제 도구 확인·문제 해결을 설명한다.
- [웹](docs/web.md) — 크기를 조절하는 작업 공간·편집기 그룹과 오른쪽 도니 대화, 통합 설정을 제공한다. 노트·이력·첨부 UX, 단축키와 테마·간격 규칙을 설명한다.
- [실시간 이벤트](docs/events.md) — 대상별 SSE 신호와 웹 조회 캐시의 변경 경로·ID별 배치 갱신을 설명한다. 재연결 보완과 SHA 고정 조회의 보존 계약도 기록한다.
