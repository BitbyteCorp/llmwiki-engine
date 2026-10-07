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
- **Luna**: 지식을 쓰고 정리하고 답하는 OpenAI 모델(`gpt-6-luna`)이다.
- **dreaming**: 매일 03:00(KST)에 하루치 변경을 정리하는 배치 작업이다.
- **일기**: dreaming이 날짜별로 쓰는 `journal/YYYY-MM-DD.md`다.
- **메모리 파일**: Luna의 문맥을 담는 지식 저장소 루트의 `MEMORY.md`다.
- **작업 워크트리**: 쓰기와 dreaming마다 `main`에서 파생하는 git worktree다.

## 문서 색인

각 항목은 다음 형식으로 기록한다.
`- [주제](docs/topic.md) — 주제를 한두 문장으로 요약한다.`

### 구성

- [아키텍처](docs/architecture.md) — 컨테이너 하나, Node 프로세스 하나에 웹·MCP·OAuth·작업 큐·스케줄러·인덱서를 함께 띄우는 구성이다.
- [Luna](docs/luna.md) — 엔진이 쓰는 LLM과 그 도구, 임베딩을 별도 모델로 두는 이유다.
- [지식 저장소](docs/knowledge-repository.md) — `main`이 진실 원천이고 GitHub는 하루 한 번 push되는 백업이며, LLM Wiki 표준을 따른 레이아웃을 쓴다.

### 흐름

- [쓰기 흐름](docs/write-flow.md) — 작업 워크트리에서 Luna가 수정·커밋하고 `main`에 직렬로 머지하며, 충돌은 Luna가 푼다.
- [dreaming](docs/dreaming.md) — 매일 03:00 KST에 충돌·중복을 정리하고 일기를 쓴 뒤 GitHub에 push한다.
- [작성 규칙](docs/writing-rules.md) — Luna가 지식 저장소에 쓸 때 따르는 Obsidian 기반 규칙이다.
- [RAG](docs/rag.md) — SQLite 하나에 키워드·벡터·링크 인덱스를 두고 하이브리드 검색을 한다.

### 접점

- [인증](docs/auth.md) — Google Workspace 로그인과, 엔진이 인가 서버가 되는 MCP OAuth다.
- [MCP](docs/mcp.md) — 지식 저장소의 모든 읽기·쓰기·검색을 제공하는 MCP 서버다.
- [설치형 Skills](docs/skills.md) — Claude Code, Codex, Hermes에 MCP 연결과 사용 프롬프트를 설치한다.
- [웹](docs/web.md) — 위키 탐색과 Luna 질의응답을 제공하며 shadcn/ui로 만든다.
