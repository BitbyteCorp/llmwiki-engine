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

- 웹 UI와 HTTP API는 [웹 버전](web.md)의 탐색, 읽기와 질의응답을 제공한다.
- MCP 엔드포인트는 [MCP](mcp.md)의 클라이언트 접점이며, OAuth 인가 서버 엔드포인트는 [인증](auth.md)의 로그인과 인가를 담당한다.
- 쓰기 작업 큐는 [쓰기 흐름](write-flow.md)을 처리하고, 스케줄러는 [dreaming](dreaming.md)을 실행한다.
- 인덱서는 [RAG](rag.md)에 필요한 검색 인덱스를 관리한다.

### 영속 데이터와 SQLite
영속 데이터는 `/data` 볼륨 하나에 모은다. 볼륨에는 지식 저장소 클론, 작업 워크트리, SQLite 파일이 들어간다. SQLite 파일은 사용자, 세션, OAuth 클라이언트와 토큰, 검색 인덱스를 담는다. 쓰기 작업 상태의 저장 계약은 [쓰기 흐름](write-flow.md#비동기-작업과-상태-조회)에, 웹 대화 기록의 저장 계약은 [웹 버전](web.md#대화-기록과-학습)에 기록한다.

예를 들어 OAuth 세션과 검색 인덱스는 서로 다른 용도의 데이터지만, 별도 서비스 없이 같은 SQLite에 저장한다. 지식 파일의 배치와 백업 정책은 [지식 저장소](knowledge-repository.md)에서 다룬다.

### DB 선택
PostgreSQL을 대안으로 검토했으며 현재 설계는 SQLite를 유지한다. SQLite 유지 권고는 사용자의 최종 확인 전이다.

결정적인 이유는 엔진이 어차피 인스턴스 하나로 동작한다는 점이다. 지식 저장소 git 클론과 작업 워크트리는 로컬 디스크에 있고, [main 머지](write-flow.md)는 락으로 직렬 처리한다. 따라서 PostgreSQL이 제공하는 여러 인스턴스의 DB 공유나 고가용성의 이점을 현재 구성에서는 활용할 수 없다.

컨테이너 하나라는 요구도 SQLite에 유리하다. PostgreSQL을 같은 컨테이너에 넣으면 프로세스 감시자(supervisor)가 필요하고, 컨테이너 밖에 두면 서비스가 둘이 된다. SQLite는 `/data` 볼륨의 파일 하나로 운영한다.

SQLite 파일과 지식 저장소는 같은 볼륨에 있으므로 볼륨 하나만 백업하면 된다. 검색 인덱스는 [git 기반 재구축](rag.md#증분-인덱싱과-복구)이 가능하므로 DB 유실 시 잃는 비파생 데이터는 사용자·세션·OAuth 토큰·작업 기록·대화 기록이다. 지식 저장소의 GitHub 백업과 볼륨 백업의 범위는 구분한다.

한국어 검색에서도 PostgreSQL이 유리하지 않다. PostgreSQL 기본 전문 검색도 한국어 형태소를 인식하지 못하므로 `pg_trgm`이나 별도 설치가 필요한 `pg_bigm`을 사용해야 한다. 따라서 [SQLite FTS5 trigram](rag.md#저장-구조와-한국어-검색) 대비 이점이 없다.

sqlite-vec는 검토 시점에 1.0 이전 버전인 0.1.9이며, 근사 최근접(ANN) 인덱스 없이 전수 비교한다는 위험이 있다. 수천~수만 청크 규모에서는 문제가 없을 것으로 추정하며, 이는 검증된 성능 보장이 아니다. 검색은 하나의 모듈 경계 뒤에 두어 나중에 pgvector 등으로 교체할 수 있게 한다.

PostgreSQL로 전환할 조건은 엔진을 여러 인스턴스로 띄워야 할 때, 관리형 DB를 이미 운영하고 있을 때, 청크 수가 수십만 이상으로 커져 전수 비교가 느려질 때다.

### 외부 의존과 git 실행
OpenAI API는 [Luna](luna.md)와 임베딩에, Google OAuth는 [인증](auth.md)에, GitHub는 [지식 저장소 백업](knowledge-repository.md)에 사용한다. 컨테이너 이미지에는 git CLI를 포함하고, GitHub push 인증은 SSH 배포 키를 기본값으로 한다.

## 관련 문서
- [지식 저장소](knowledge-repository.md)는 엔진이 관리하는 지식 파일과 백업 정책을 설명한다.
- [Luna](luna.md)는 엔진의 LLM과 함수 도구 경계를 설명한다.
- [인증](auth.md), [MCP](mcp.md), [웹 버전](web.md)은 외부 접점을 설명한다.
- [쓰기 흐름](write-flow.md), [dreaming](dreaming.md), [RAG](rag.md)는 작업과 검색의 상세 동작을 설명한다.
