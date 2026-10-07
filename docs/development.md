# 개발 환경과 실행
엔진과 웹의 독립 패키지, 모듈별 책임, 환경 변수, 로컬 실행과 Docker 이미지 구성을 설명한다.

## 배경
엔진은 별도 지식 저장소를 관리하는 단일 Node 프로세스다. 개발 문서인 이 저장소의 `docs/`와 엔진이 생성하는 지식 저장소는 구분한다. 런타임의 경계와 SQLite 선택 이유는 [엔진 아키텍처](architecture.md)에 기록한다. 이 문서의 명령은 로컬 개발과 이미지 검증용이며 상용 배포를 수행하지 않는다.

## 내용
### 스택과 패키지 경계
- Node.js 24, TypeScript, ESM, pnpm 10.34.6을 사용한다. TypeScript는 엄격 모드와 `NodeNext` 모듈 해석을 사용하며, 소스의 로컬 import에는 빌드 결과에 맞는 `.js` 확장자를 쓴다.
- 루트는 Express 5 기반 서버 패키지다. 개발은 `tsx`, 컴파일은 `tsc`, 테스트는 Vitest를 사용한다.
- 상태와 검색 인덱스는 `better-sqlite3`와 `sqlite-vec`로 SQLite에 저장한다. ORM 없이 SQL 마이그레이션을 적용한다.
- Luna는 OpenAI SDK의 Responses API와 함수 도구를 사용한다. 환경 변수 검증은 Zod, CLI는 Commander, 로그는 Pino, 스케줄은 Croner, JWT/JWKS는 Jose, frontmatter는 gray-matter를 사용한다. Git은 `git` CLI를 인자 배열로 실행한다.
- `web/`는 Vite, React 19, TypeScript, Tailwind CSS 4, shadcn/ui를 사용하는 별도 패키지다. 화면 경로는 React Router, 서버 상태는 TanStack Query, 마크다운은 react-markdown과 remark-gfm이 담당한다. 세부 화면 구성은 [웹](web.md)에 기록한다.
- pnpm workspace는 사용하지 않는다. 루트와 `web/`는 각각 `package.json`과 `pnpm-lock.yaml`을 가지며 설치를 따로 실행한다. 네이티브 빌드 허용 목록은 루트의 `better-sqlite3`, `esbuild`를 대상으로 한다.

### 레이아웃과 책임
| 경로 | 책임 |
| --- | --- |
| `src/config.ts`, `src/log.ts` | 환경 변수 검증과 로그를 담당한다. |
| `src/db/index.ts`, `src/db/migrations/` | SQLite 연결과 파일명 순서의 SQL 마이그레이션을 담당한다. 적용 이력은 `schema_migrations`에 기록한다. |
| `src/context.ts`, `src/main.ts` | 공용 컨텍스트를 만들고 저장소·인덱서·작업 처리·스케줄러·HTTP 서버를 연결한다. |
| `src/http/app.ts`, `src/cli.ts` | HTTP 라우터와 정적 웹, 오류 처리를 묶고 각 모듈의 CLI 명령을 등록한다. |
| `src/knowledge/`, `src/jobs/` | 지식 저장소의 git 조작과 쓰기 작업의 실행·상태·머지를 담당한다. |
| `src/luna/`, `src/knowledge/seed/` | 에이전트 루프와 도구, 빈 지식 저장소의 초기 문서를 담당한다. |
| `src/rag/` | 파생 검색 인덱스와 검색·재구축 명령을 담당한다. |
| `src/auth/` | 사용자·권한·설정, Google 로그인, 웹 세션, MCP OAuth를 담당한다. |
| `src/mcp/`, `src/api/` | MCP 도구와 웹 REST API·대화 저장을 각각 담당한다. |
| `src/dreaming/` | 정기 정리와 수동 실행 명령을 담당한다. |
| `web/` | 브라우저 UI를 담당하며 `web/dist/`로 빌드한다. |
| `skills/` | 외부 클라이언트용 설치형 Skill을 담는다. |
| `test/fake-openai.ts` | 네트워크 없이 테스트할 OpenAI 호환 로컬 서버를 제공한다. |
| `scripts/` | 서버 빌드 자산 복사와 선택적인 웹 빌드를 담당한다. |

서버 모듈은 공용 컨텍스트를 통해 서로 연결하고 각 영역의 서비스와 명령을 소유한다. SQL 마이그레이션은 `001_core`, `002_auth`, `003_jobs`, `004_chat`, `005_dreaming`, `006_rag` 순서다. 벡터 테이블은 임베딩 차원 설정에 맞춰 RAG 모듈이 런타임에 생성한다.

시작 시 컨텍스트를 만든 뒤 초기 검색 인덱스 동기화를 백그라운드로 시작하고 쓰기 워커·dreaming·HTTP 서버를 띄운다. `SIGINT` 또는 `SIGTERM`을 받으면 새 HTTP 연결을 중단하고 dreaming 스케줄러를 멈춘다. HTTP 서버와 작업 서비스의 종료 및 초기 인덱스 동기화가 끝난 뒤 SQLite 연결을 닫는다.

### 루트 스크립트와 빌드 자산
| 명령 | 동작 |
| --- | --- |
| `pnpm dev` | `tsx watch src/main.ts`로 서버를 실행한다. |
| `pnpm build` | `tsc` 후 SQL 마이그레이션과 지식 저장소 seed를 복사하고, `web/package.json`이 있으면 웹을 빌드한다. |
| `pnpm start` | `node dist/main.js`로 빌드된 서버를 실행한다. |
| `pnpm cli <명령>` | `tsx src/cli.ts`로 로컬 관리 명령을 실행한다. |
| `pnpm typecheck` | `tsc --noEmit`으로 서버 타입을 검사한다. |
| `pnpm test` | Vitest를 실행한다. |
| `pnpm --dir web dev` | 별도 웹 개발 서버를 실행한다. |

빌드 결과에는 `dist/main.js`, `dist/cli.js`, `dist/db/migrations/*.sql`, `dist/knowledge/seed/`가 들어간다. SQL과 seed는 TypeScript 컴파일만으로 생성되지 않으므로 자산 복사 단계를 생략하지 않는다. 웹 패키지가 있으면 먼저 웹 의존성을 설치해야 하며, Express는 `web/dist/`를 정적으로 제공한다. 웹 패키지가 없는 경우 서버만 빌드한다.

### OpenAI 로컬 테스트 fixture
`test/fake-openai.ts`의 `startFakeOpenAI(script?: readonly FakeTurn[])`는 `Promise<{ url, close, requests }>`를 반환한다. 서버는 루프백 주소의 임시 포트를 사용하며 `url`에는 이미 `/v1`이 포함된다. OpenAI SDK의 `baseURL` 또는 엔진의 `OPENAI_BASE_URL`에 그대로 전달하고 테스트 종료 시 `await close()`로 정리한다.

`script`는 `/v1/responses` 요청마다 한 턴씩 소비하는 큐다. 턴은 문자열, `{ text }`, `{ functionCalls, text? }`, `{ output }` 형식을 지원한다. `functionCalls`의 각 호출은 `name`, JSON 문자열이나 객체인 `arguments`, 선택적인 `call_id`를 가지며 `output` 배열은 텍스트와 함수 호출을 함께 담을 수 있다. 일반 응답과 SSE 스트리밍 응답을 모두 제공한다. 큐가 소진되면 임의의 답을 생성하지 않고 HTTP 400과 `fake_script_exhausted` 오류를 반환한다.

`requests`는 메서드·경로·요청 본문을 순서대로 기록하므로 에이전트가 도구 결과를 다음 요청에 넘겼는지 확인할 수 있다. `/v1/embeddings`는 SHA-256으로 시드한 결정론적 정규화 벡터를 반환하고 응답 큐를 소비하지 않는다. 요청의 `dimensions`를 사용하며 기본값은 1536이다. float 배열과 base64 인코딩을 지원한다.

fixture의 범위를 검증하는 명령은 `pnpm vitest run test/fake-openai.test.ts`다. 이 fixture는 OpenAI API의 유료 호출이나 외부 네트워크 없이 도구 호출과 스트리밍을 재현하기 위한 것이며 실제 모델 품질을 평가하지 않는다.

### 환경 변수
설정은 프로세스 환경 변수에서 읽는다. 키와 비밀값은 저장소나 이미지에 넣지 않고 실행 시 전달한다.

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `NODE_ENV` | `development` | Docker 이미지는 `production`으로 설정한다. 개발 로그인 허용 여부와 세션 설정에 영향을 준다. |
| `PORT` | `3000` | HTTP 수신 포트다. |
| `PUBLIC_URL` | `http://localhost:3000` | 외부 기준 URL이며 OAuth issuer와 리디렉션에 사용한다. |
| `DATA_DIR` | `./data` | 영속 데이터 루트다. Docker에서는 `/data`다. |
| `SESSION_SECRET` | 상용 모드에서 필수 | 세션 쿠키 서명 비밀값이다. 개발·테스트에서 생략하면 시작마다 무작위로 생성하므로 재시작 후 기존 세션이 무효화된다. |
| `OPENAI_API_KEY` | 미설정 | 시작 시 필수는 아니지만 Luna와 임베딩 실행에는 필요하다. 미설정이면 해당 기능이 명확한 오류로 실패한다. |
| `OPENAI_BASE_URL` | 미설정 | OpenAI 호환 API 주소를 재정의한다. 테스트 서버 연결에도 사용한다. |
| `LUNA_MODEL` | `gpt-6-luna` | Luna의 응답 모델이다. |
| `LUNA_REASONING_EFFORT` | `medium` | Luna의 추론 강도다. |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | 검색 임베딩 모델이다. |
| `EMBEDDING_DIMENSIONS` | `1536` | 임베딩 벡터 차원이다. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 미설정 | Google 로그인에 필요하다. 미설정 상태에서도 부팅할 수 있지만 Google 로그인은 실패한다. |
| `KNOWLEDGE_REPO_URL` | 미설정 | 지식 저장소의 git 원격 주소다. 없으면 로컬 `main` 저장소를 생성하고 일일 push를 건너뛰며 로그로 남긴다. |
| `GIT_SSH_KEY_PATH` | 미설정 | git의 `GIT_SSH_COMMAND`에서 사용하는 SSH 배포 키 경로다. |
| `GIT_BOT_NAME`, `GIT_BOT_EMAIL` | `Luna`, `luna@llmwiki.local` | git 커미터 정보다. |
| `DREAM_CRON` | `0 3 * * *` | dreaming 실행 일정이다. |
| `TZ_DREAM` | `Asia/Seoul` | dreaming 일정의 시간대다. |
| `DEV_LOGIN_EMAIL` | 미설정 | 개발 모드에서만 기존 사용자로 `/auth/dev-login` 로그인을 허용한다. 상용 모드에서 설정하면 시작을 거부한다. |

`DATA_DIR/knowledge`에는 지식 저장소 클론, `DATA_DIR/worktrees`에는 작업 워크트리, `DATA_DIR/llmwiki.db`에는 상태와 검색 인덱스를 둔다. 데이터 경로는 CLI와 서버에서 동일하게 설정해야 한다.

### 로컬 실행과 첫 관리자
Node.js 24와 pnpm 10.34.6, git이 필요하다. `better-sqlite3`의 사전 빌드 바이너리를 사용할 수 없는 환경에서는 Python 3, make, C++ 컴파일러가 필요하다. 다음 명령은 저장소 루트에서 실행한다.

```bash
corepack enable
corepack prepare pnpm@10.34.6 --activate
pnpm install --frozen-lockfile
pnpm --dir web install --frozen-lockfile

export DATA_DIR="$PWD/data"
export NODE_ENV=development
export SESSION_SECRET="$(openssl rand -hex 32)"
pnpm cli user add admin@example.com --role admin
DEV_LOGIN_EMAIL=admin@example.com pnpm dev
```

별도 터미널에서 `pnpm --dir web dev`로 UI 개발 서버를 실행한다. 서버가 준비되면 `http://localhost:3000/auth/dev-login`에 접근해 등록한 관리자 세션을 만든다. 개발 로그인은 Google 없이 로컬 화면을 확인하기 위한 접점이며 신규 사용자를 자동 생성하지 않는다. 사용자 이메일은 CLI로 미리 등록해야 한다. API 키 없이 로컬 인증과 저장소를 확인할 수 있지만 Luna의 응답과 임베딩을 확인하려면 `OPENAI_API_KEY`가 필요하다.

정적 웹을 포함한 단일 서버를 확인할 때는 웹 개발 서버 대신 `pnpm build` 후 `DEV_LOGIN_EMAIL=admin@example.com pnpm start`를 사용한다. 관리자 권한 복구는 `pnpm cli user role admin@example.com admin`으로 수행한다. 첫 관리자 이후의 사용자·권한·허용 도메인 설정은 웹 관리 화면에서 변경하며 정책은 [인증](auth.md)에 기록한다.

### Docker 이미지와 영속 볼륨
Dockerfile은 `node:24-bookworm-slim` 기반의 두 단계 빌드를 사용한다. 빌드 단계에서 루트와 선택적인 웹 패키지를 각각 frozen lockfile로 설치하고 루트 `pnpm build`를 실행한다. 이후 서버 개발 의존성을 제거한다. 실행 단계에는 서버 운영 의존성, `dist/`, `web/dist/`만 복사하며 git, openssh-client, tini를 설치한다. 웹 패키지가 없으면 빈 `web/dist/`를 두어 서버 전용 이미지도 만들 수 있다.

실행 사용자는 root가 아닌 `node`다. tini가 PID 1에서 신호와 자식 프로세스를 처리하며 `node dist/main.js`를 실행한다. `llmwiki` 실행 파일은 `PATH`에 있으므로 컨테이너 안에서도 관리 명령을 직접 호출할 수 있다. `/healthz`는 설정된 HTTP 포트에서 이미지의 healthcheck에 사용한다.

다음은 **로컬 이미지 확인용** 예시다. Google 없이 로그인하기 위해 이 예시만 `NODE_ENV=development`로 덮어쓴다. Dockerfile 기본값은 `production`이며 그 상태에서는 `DEV_LOGIN_EMAIL`을 전달하면 안 된다.

```bash
docker build -t llmwiki-engine:local .
docker volume create llmwiki-local-data
export LOCAL_SESSION_SECRET="$(openssl rand -hex 32)"
docker run -d --name llmwiki-local \
  -p 127.0.0.1:3000:3000 \
  -v llmwiki-local-data:/data \
  -e NODE_ENV=development \
  -e SESSION_SECRET="$LOCAL_SESSION_SECRET" \
  -e DEV_LOGIN_EMAIL=admin@example.com \
  llmwiki-engine:local
docker exec llmwiki-local llmwiki user add admin@example.com --role admin
curl --fail http://localhost:3000/healthz
```

관리자를 등록한 뒤 `http://localhost:3000/auth/dev-login`을 연다. 이미지 실행에 OpenAI 기능이 필요하면 `OPENAI_API_KEY`를 실행 환경으로 전달한다. `/data`를 named volume으로 보존하면 컨테이너를 다시 만들어도 지식과 SQLite 상태를 유지한다. 호스트 디렉터리를 bind mount할 경우 이미지의 `node` 사용자 UID/GID가 쓰기 가능한 권한을 미리 설정해야 한다. 볼륨 전체 백업과 지식 저장소의 git 원격 백업은 서로 다른 범위를 보호한다.

SSH 키는 이미지에 복사하지 않는다. 원격 git이 필요할 때는 키와 검증된 `known_hosts`를 실행 사용자에게 읽기 가능한 읽기 전용 마운트로 제공하고 `GIT_SSH_KEY_PATH`를 설정한다. `.dockerignore`는 git 메타데이터, 설치·빌드 결과, 로컬 데이터, 환경 파일, SSH 디렉터리와 키 파일을 빌드 컨텍스트에서 제외한다.

## 관련 문서
- [엔진 아키텍처](architecture.md)는 단일 컨테이너와 SQLite 선택의 배경을 설명한다.
- [인증](auth.md)은 관리자 부트스트랩 이후 적용되는 사용자와 로그인 정책을 설명한다.
- [지식 저장소](knowledge-repository.md)는 영속 지식의 구조와 원격 백업 범위를 설명한다.
- [웹](web.md), [MCP](mcp.md), [RAG](rag.md)는 각 모듈의 외부 계약을 설명한다.
