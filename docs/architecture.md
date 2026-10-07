# 엔진 아키텍처
엔진은 하나의 컨테이너와 하나의 Node 프로세스 안에서 웹, MCP, 인증, 쓰기 작업, dreaming, 검색 인덱싱을 함께 제공한다.

## 배경
사용자는 Dockerfile 하나와 컨테이너 하나로 운영하는 구성을 요구했다. 엔진은 이 요구에 맞춰 별도 데이터베이스나 벡터 검색 서비스를 두지 않고, TypeScript로 구현하는 Node.js 서비스와 SQLite를 중심으로 구성한다.

## 내용
### 구성 요소와 경계
다음 그림은 컨테이너 내부의 구성 요소, 영속 볼륨, 외부 의존을 구분한다.

```mermaid
flowchart TB
    subgraph container[컨테이너 하나]
        subgraph node[Node 프로세스 하나 · TypeScript]
            web[웹 UI · HTTP API]
            mcp[MCP 엔드포인트 · Streamable HTTP]
            oauth[OAuth 인가 서버 엔드포인트]
            queue[쓰기 작업 큐]
            scheduler[dreaming 스케줄러]
            indexer[RAG 인덱서]
        end
        git[git CLI]
    end

    subgraph data[/data 영속 볼륨]
        repo[지식 저장소 클론]
        worktrees[작업 워크트리]
        sqlite[SQLite 파일 · 상태와 검색 인덱스]
    end

    openai[OpenAI API · Luna와 임베딩]
    google[Google OAuth]
    github[GitHub · 백업]

    web --> openai
    queue --> openai
    scheduler --> openai
    indexer --> openai
    oauth --> google
    web --> sqlite
    mcp --> sqlite
    oauth --> sqlite
    mcp --> queue
    queue --> worktrees
    scheduler --> worktrees
    queue --> git
    scheduler --> git
    git --> repo
    git --> worktrees
    git --> github
    indexer --> repo
    indexer --> sqlite
```

- 웹 UI와 HTTP API는 [웹 버전](web.md)의 탐색, 읽기, 질의응답과 관리 기능을 제공한다.
- MCP 엔드포인트는 [MCP](mcp.md)의 클라이언트 접점이며, OAuth 인가 서버 엔드포인트는 [인증](auth.md)의 로그인과 인가를 담당한다.
- 쓰기 작업 큐는 [쓰기 흐름](write-flow.md)을 처리하고, 스케줄러는 [dreaming](dreaming.md)을 실행한다.
- 인덱서는 [RAG](rag.md)에 필요한 검색 인덱스를 관리한다.

### 영속 데이터와 SQLite
영속 데이터는 `/data` 볼륨 하나에 모은다. 볼륨에는 지식 저장소 클론, 작업 워크트리, SQLite 파일이 들어간다. SQLite 파일은 사용자, 세션, OAuth 클라이언트와 토큰, 작업 상태, 검색 인덱스를 담는다.

예를 들어 OAuth 세션과 검색 인덱스는 서로 다른 용도의 데이터지만, 별도 서비스 없이 같은 SQLite에 저장한다. Postgres나 별도 벡터 DB를 두지 않는 이유는 컨테이너 하나로 운영한다는 요구를 유지하기 위해서다. 지식 파일의 배치와 백업 정책은 [지식 저장소](knowledge-repository.md)에서 다룬다.

### 외부 의존과 git 실행
OpenAI API는 [Luna](luna.md)와 임베딩에, Google OAuth는 [인증](auth.md)에, GitHub는 [지식 저장소 백업](knowledge-repository.md)에 사용한다. 컨테이너 이미지에는 git CLI를 포함하고, GitHub push 인증은 SSH 배포 키를 기본값으로 한다.

## 관련 문서
- [지식 저장소](knowledge-repository.md)는 엔진이 관리하는 지식 파일과 백업 정책을 설명한다.
- [Luna](luna.md)는 엔진의 LLM과 함수 도구 경계를 설명한다.
- [인증](auth.md), [MCP](mcp.md), [웹 버전](web.md)은 외부 접점을 설명한다.
- [쓰기 흐름](write-flow.md), [dreaming](dreaming.md), [RAG](rag.md)는 작업과 검색의 상세 동작을 설명한다.
