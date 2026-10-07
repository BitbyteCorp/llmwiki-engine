# 엔진 아키텍처
엔진은 하나의 컨테이너와 하나의 Node 프로세스 안에서 웹, MCP, 인증, 쓰기 작업, dreaming, 검색 인덱싱을 함께 제공한다.

## 배경
사용자는 MVC 구조와 Dockerfile 하나·컨테이너 하나·Node 프로세스 하나로 운영하는 구성을 요구했다. 엔진은 이 요구에 맞춰 NestJS로 서버의 컨트롤러·서비스·모듈과 DI를 구성하고 Next.js App Router로 뷰를 제공한다. 별도 데이터베이스나 벡터 검색 서비스를 두지 않고 SQLite를 사용한다. 이 전환은 실행 구조를 바꾸며 REST·MCP 계약, 환경 설정, DB 스키마와 지식 처리 규칙은 유지한다.

## 내용
### 구성 요소와 경계
다음 그림은 컨테이너 내부의 구성 요소, 영속 볼륨, 외부 의존을 구분한다.

```mermaid
flowchart TB
    subgraph container[컨테이너 하나]
        subgraph node[Node 프로세스 하나 · TypeScript]
            view[Next.js App Router · 뷰]
            web[NestJS · HTTP API]
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
    view --> web
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

- Next.js 웹 UI와 NestJS HTTP API는 [웹 버전](web.md)의 탐색, 읽기와 질의응답을 제공한다.
- MCP 엔드포인트는 [MCP](mcp.md)의 클라이언트 접점이며, OAuth 인가 서버 엔드포인트는 [인증](auth.md)의 로그인과 인가를 담당한다.
- 쓰기 작업 큐는 [쓰기 흐름](write-flow.md)을 처리하고, 스케줄러는 [dreaming](dreaming.md)을 실행한다.
- 인덱서는 [RAG](rag.md)에 필요한 검색 인덱스를 관리한다.
- 전역 `EventsModule`은 대상별 변경 신호를 발행하고 `OpsModule`은 활동 조회, 준비 상태와 운영 지표를 제공한다. [실시간 이벤트](events.md)와 [운영](operations.md)에 전달·인증 계약을 기록한다.

### NestJS와 Next.js의 MVC 경계
모델은 `*.repository.ts`의 SQL·git 데이터 접근과 `*.entity.ts` 또는 `*.types.ts`의 데이터 형식으로 구성한다. 서비스는 `*.service.ts`에서 업무 규칙을 수행하며 Nest의 `@Injectable()` 제공자로 등록한다. 컨트롤러는 `*.controller.ts`에서 요청을 해석·검증하고 서비스를 호출해 응답을 만든다. DTO의 Zod 스키마와 공용 `ZodValidationPipe`가 입력 검증을 담당한다. 기능별 `*.module.ts`는 제공자와 컨트롤러를 묶고 모듈 간 의존성을 DI로 연결한다. 뷰는 `web/`의 Next.js App Router 앱이다.

Nest가 Express 어댑터의 HTTP 서버와 수신 포트를 소유한다. `src/main.ts`는 Next custom server에 개발 모드 여부, `web` 디렉터리, `PUBLIC_URL`의 호스트 이름과 설정된 `PORT`를 전달해 준비하고 Nest 라우트보다 앞에 Express 미들웨어를 등록한다. 개발 origin과 HMR의 호스트 설정은 [개발 환경과 실행](development.md#로컬-실행과-첫-관리자)에 기록한다. 경로가 `^/(api|auth|oauth|mcp|\.well-known|healthz|readyz|metrics)(/|$)`와 일치하면 Nest가 처리하고, 나머지 경로는 Next 요청 핸들러로 전달한다. 따라서 `/api`, 인증·OAuth, MCP, 상태 확인과 지표는 서버 컨트롤러에 남고 화면과 Next 자산은 같은 주소에서 제공된다. SSE 응답은 이 경계에서 Next의 렌더링이나 버퍼링을 거치지 않는다.

Next custom server를 선택한 이유는 Nest의 MVC·DI 구조를 사용하면서도 프로세스와 컨테이너를 하나로 유지하기 위해서다. 별도 Next 서버나 개발용 UI 포트를 두지 않으며 Next의 standalone 출력도 사용하지 않는다. 개발 시에도 한 진입점이 Nest와 Next 개발 모드를 함께 실행한다. 빌드·메타데이터 설정과 컨테이너에 필요한 자산은 [개발 환경과 실행](development.md)에 기록한다.

### 영속 데이터와 SQLite
영속 데이터는 Docker에서 `/data` 볼륨 하나에 모으며 로컬 실행에서는 `DATA_DIR`를 사용한다. 볼륨에는 지식 저장소 클론, 작업 워크트리, SQLite 파일과 업로드 원본이 들어간다. SQLite 파일은 사용자·설정·폴더 접근 규칙, 세션, OAuth 클라이언트와 토큰, 작업·dreaming·대화·생성 이벤트·수집·업로드·감사 기록, 검색 인덱스를 담는다. 쓰기 작업 상태의 저장 계약은 [쓰기 흐름](write-flow.md#비동기-작업과-상태-조회)에, 웹 대화 기록의 저장 계약은 [웹 버전](web.md#대화-기록과-학습)에 기록한다.

예를 들어 OAuth 세션과 검색 인덱스는 서로 다른 용도의 데이터지만, 별도 서비스 없이 같은 SQLite에 저장한다. 지식 파일의 배치와 백업 정책은 [지식 저장소](knowledge-repository.md)에서 다룬다.

### DB 선택
PostgreSQL을 대안으로 검토했으며 SQLite 사용을 확정했다. 구현은 `better-sqlite3`와 `sqlite-vec`를 사용하고, WAL 모드와 SQL 마이그레이션으로 상태와 검색 인덱스를 관리한다.

결정적인 이유는 엔진이 어차피 인스턴스 하나로 동작한다는 점이다. 지식 저장소 git 클론과 작업 워크트리는 로컬 디스크에 있고, [main 머지](write-flow.md)는 락으로 직렬 처리한다. 따라서 PostgreSQL이 제공하는 여러 인스턴스의 DB 공유나 고가용성의 이점을 현재 구성에서는 활용할 수 없다.

컨테이너 하나라는 요구도 SQLite에 유리하다. PostgreSQL을 같은 컨테이너에 넣으면 프로세스 감시자(supervisor)가 필요하고, 컨테이너 밖에 두면 서비스가 둘이 된다. SQLite는 `/data` 볼륨의 파일 하나로 운영한다.

SQLite 파일·업로드 원본·지식 저장소가 같은 볼륨에 있지만 실행 중인 볼륨 파일을 그대로 복사하는 것은 일관된 백업을 보장하지 않는다. [백업과 복원](backup.md)의 SQLite 스냅샷·지식 git bundle·업로드 보관 절차를 사용한다. 검색 인덱스는 [git 기반 재구축](rag.md#증분-인덱싱과-복구)이 가능하지만 사용자·설정·접근 규칙·세션·OAuth 토큰·작업·dreaming·대화·수집·감사 기록 등은 비파생 데이터이므로 DB 유실 후 git만으로 복구하지 못한다. 지식 저장소의 GitHub 백업과 전체 데이터 백업의 범위는 구분한다.

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
- [개발 환경과 실행](development.md)은 구현 스택, 모듈별 책임, 환경 변수, 로컬 실행과 Docker 이미지의 빌드·영속 볼륨 구성을 설명한다.
