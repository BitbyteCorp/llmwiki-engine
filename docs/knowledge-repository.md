# 지식 저장소
지식 저장소는 엔진과 분리된 git 저장소이며, main을 진실 원천으로 삼아 LLM Wiki 형식의 지식과 날짜별 일기를 관리한다.

## 배경
엔진 저장소의 `CONTEXT.md`와 `docs/`는 개발 문서이고, 지식 저장소는 엔진이 관리하는 위키 본문을 담는다. 두 저장소는 별개다. 지식 저장소의 기본 구조는 Karpathy의 LLM Wiki 패턴을 따르되, Obsidian에서 읽을 수 있는 노트 형식과 날짜별 일기를 반영한다.

## 내용
### 저장소 수와 원문 수집 범위
엔진이 관리하는 지식 저장소는 하나로 고정한다. 원문 수집은 현재 텍스트만 대상으로 하며, 파일·URL·PDF 업로드는 범위 밖이다.

### main과 GitHub 백업
지식 저장소의 기본 브랜치는 `main`이며, main이 진실 원천이다. GitHub는 사실상 백업으로 사용하고, push는 dreaming 후 하루 한 번 수행한다. 서버 디스크를 잃으면 최대 하루치 변경이 사라질 수 있으며, 사용자는 이 손실 범위를 수용했다.

예를 들어 당일의 변경이 main에 들어갔더라도 다음 백업 push 전에는 GitHub에 없을 수 있다. GitHub의 상태가 곧 최신 지식이라고 가정하지 않는다. 변경이 main에 반영되는 절차는 [쓰기 흐름](write-flow.md)에, 백업 실행 절차는 [dreaming](dreaming.md)에 기록한다.

### 디렉터리 레이아웃
다음은 지식 저장소 루트의 구조다.

```text
.
├── raw/
├── wiki/
├── index.md
├── journal/
│   └── YYYY-MM-DD.md
├── MEMORY.md
└── AGENTS.md
```

- `raw/`는 불변 원문 소스를 담는다.
- `wiki/`는 Luna가 유지하는 노트를 담으며, frontmatter, 태그, 위키링크를 사용해 Obsidian 볼트로 열 수 있다.
- `index.md`는 큐레이션된 진입점 색인이며, Obsidian 규칙의 index note 역할도 한다.
- `journal/YYYY-MM-DD.md`는 dreaming이 날짜별로 쓰는 일기다. LLM Wiki 표준의 `log.md`를 대신하며, 세부 변경 이력은 git 커밋 이력이 담는다.
- `MEMORY.md`는 즉시 필요한 자주 바뀌는 정보를 담는 메모리 파일이며, 전체 공용으로 하나를 둔다. MCP 클라이언트는 세션 시작 시 이 파일을 먼저 읽는다.
- 지식 저장소 안의 `AGENTS.md`는 Luna의 [작성 규칙](writing-rules.md)을 담는 schema 파일이다. 엔진 저장소의 작업 규칙 파일과 구분한다.

Obsidian 규칙의 LiveSync는 사용하지 않으며, git 동기화로 대체한다. 예를 들어 위키의 진입점은 `index.md`에서 찾고, 날짜별 정리 내용은 `journal/YYYY-MM-DD.md`에서 읽으며, 개별 변경은 git 커밋 이력으로 확인한다.

### LLM Wiki 표준과의 대응
다음 표는 표준의 각 구성 요소를 이 레이아웃에서 어디에 두는지 설명한다.

| LLM Wiki 표준 구성 요소 | 지식 저장소 위치 | 대응 방식 |
| --- | --- | --- |
| raw sources | `raw/` | 불변 원문 소스를 보관한다. |
| wiki | `wiki/` | Luna가 유지하는 노트를 보관한다. |
| index | `index.md` | 큐레이션된 진입점을 제공한다. |
| log | `journal/YYYY-MM-DD.md` | `log.md` 대신 날짜별 일기를 쓰고, 세부 변경 이력은 git 커밋 이력으로 남긴다. |
| schema | `AGENTS.md` | Luna의 작성 규칙을 담는다. |

메모리 파일은 위 대응표와 별도로, 세션 시작 시 즉시 필요한 공용 정보를 제공한다.

## 관련 문서
- [엔진 아키텍처](architecture.md)는 지식 저장소 클론과 작업 워크트리의 영속 위치를 설명한다.
- [작성 규칙](writing-rules.md)은 지식 저장소 안의 문서 작성 기준을 설명한다.
- [쓰기 흐름](write-flow.md)과 [dreaming](dreaming.md)은 지식 변경과 정리 절차를 설명한다.
- [MCP](mcp.md)는 메모리 파일을 비롯한 지식의 제공 방식을 설명한다.
- [RAG](rag.md)는 지식 저장소에서 검색 인덱스를 만드는 방식을 설명한다.
