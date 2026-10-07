# 개발 환경과 실행
단일 루트 패키지의 NestJS 서버와 Next.js 웹, 모듈별 책임, 환경 변수, 로컬 실행과 Docker 이미지 구성을 설명한다.

## 배경
엔진은 별도 지식 저장소를 관리하는 단일 Node 프로세스다. 개발 문서인 이 저장소의 `docs/`와 엔진이 생성하는 지식 저장소는 구분한다. 런타임의 경계와 SQLite 선택 이유는 [엔진 아키텍처](architecture.md)에 기록한다. 이 문서의 명령은 로컬 개발과 이미지 검증용이며 상용 배포를 수행하지 않는다.

## 내용
### 스택과 패키지 경계
- Node.js 24, TypeScript 6, ESM, pnpm 10.34.6을 사용한다. 서버 TypeScript는 엄격 모드와 `NodeNext` 모듈 해석을 사용하며, 소스의 로컬 import에는 빌드 결과에 맞는 `.js` 확장자를 쓴다.
- 서버는 NestJS와 Express 어댑터를 사용한다. 개발과 CLI 실행은 SWC의 `@swc-node/register/esm-register`, 서버 컴파일은 `tsc`, 테스트는 Vitest와 `unplugin-swc`를 사용한다.
- 상태와 검색 인덱스는 `better-sqlite3`와 `sqlite-vec`로 SQLite에 저장한다. ORM 없이 SQL 마이그레이션을 적용한다.
- Luna는 OpenAI SDK의 Responses API와 함수 도구를 사용한다. 환경 변수 검증은 Zod, CLI는 Commander, 로그는 Pino, 스케줄은 Croner, JWT/JWKS는 Jose, frontmatter는 gray-matter를 사용한다. Git은 `git` CLI를 인자 배열로 실행한다.
- `web/`는 Next.js App Router, React 19, TypeScript, Tailwind CSS 4, shadcn/ui를 사용하는 웹 프로젝트다. 화면 경로는 App Router, 서버 상태는 TanStack Query, 마크다운은 react-markdown과 remark-gfm이 담당한다. 세부 화면 구성은 [웹](web.md)에 기록한다.
- 패키지는 루트 `package.json`과 `pnpm-lock.yaml` 하나로 관리하며 설치도 루트에서 한 번만 실행한다. Next.js와 UI 의존성도 루트에 두며 `web/package.json`이나 별도 웹 lockfile은 두지 않는다.

Nest의 클래스 타입 기반 DI는 데코레이터 메타데이터에 의존한다. 서버 컴파일 설정에는 `experimentalDecorators`와 `emitDecoratorMetadata`가 필요하며 런타임에는 `reflect-metadata`를 로드한다. esbuild와 이를 사용하는 `tsx`는 이 메타데이터를 생성하지 않으므로 서버 실행 도구로 사용하지 않는다. 개발·CLI의 SWC 로더와 Vitest의 `unplugin-swc`도 메타데이터를 생성하도록 설정하며, 배포용 서버는 TypeScript 6의 `tsc`로 컴파일한다. 웹의 TypeScript 설정은 `web/tsconfig.json`으로 분리한다.
TypeScript는 데코레이터 메타데이터를 생성하는 6.0.3으로 고정한다. `web/next.config.ts`를 운영 모드에서도 읽어야 하므로 TypeScript를 운영 의존성에 남긴다. SWC 네이티브 모듈은 pnpm 빌드 허용 목록의 `@swc/core`로 설치하며 서버 빌드는 테스트 파일을 제외하는 `tsconfig.build.json`을 사용한다.
Next의 CommonJS 진입점은 호출 가능한 함수를 내보내지만 `NodeNext` 타입 해석에서는 기본 내보내기를 모듈로 해석한다. HTTP 진입점은 이 외부 패키지만 `createRequire(import.meta.url)`로 로드하며, 서버 자체의 ESM 형식과 로컬 `.js` import 규칙은 유지한다.

### 레이아웃과 책임
| 경로 | 책임 |
| --- | --- |
| `src/config.ts`, `src/log.ts` | 환경 변수 검증과 로그를 담당한다. |
| `src/db/index.ts`, `src/db/migrations/` | SQLite 연결과 파일명 순서의 SQL 마이그레이션을 담당한다. 적용 이력은 `schema_migrations`에 기록한다. |
| `src/common/`, `src/app.module.ts` | 전역 설정·로그·DB 제공자, 오류 필터·검증 파이프·상태 확인과 기능 모듈 구성을 담당한다. |
| `src/main.ts`, `src/cli.ts` | Nest와 Next를 함께 실행하는 HTTP 진입점과 Nest 애플리케이션 컨텍스트를 사용하는 관리 명령 진입점이다. |
| `src/knowledge/`, `src/jobs/` | 지식 저장소의 git 조작과 쓰기 작업의 실행·상태·머지를 담당한다. |
| `src/luna/`, `src/knowledge/seed/` | 에이전트 루프와 도구, 빈 지식 저장소의 초기 문서를 담당한다. |
| `src/rag/` | 파생 검색 인덱스와 검색·재구축 명령을 담당한다. |
| `src/auth/` | 사용자·권한·설정, Google 로그인, 웹 세션, MCP OAuth를 담당한다. |
| `src/mcp/`, `src/api/` | MCP 도구와 웹 REST API·대화 저장을 각각 담당한다. |
| `src/dreaming/` | 정기 정리와 수동 실행 명령을 담당한다. |
| `web/app/`, `web/components/`, `web/lib/` | App Router 화면, UI 컴포넌트, 웹 공용 코드를 담당한다. Next 빌드 결과는 `web/.next/`에 둔다. |
| `web/next.config.ts`, `web/tsconfig.json`, `web/postcss.config.mjs`, `web/components.json` | Next·웹 TypeScript·CSS·shadcn 설정을 담당하며 패키지 의존성은 루트에서 관리한다. |
| `web/public/` | Next가 제공할 공개 자산을 담는다. |
| `skills/` | 외부 클라이언트용 설치형 Skill을 담는다. |
| `test/fake-openai.ts` | 네트워크 없이 테스트할 OpenAI 호환 로컬 서버를 제공한다. |
| `scripts/` | 컴파일된 서버에 SQL 마이그레이션과 seed 자산을 복사한다. |

기능별 Nest 모듈은 컨트롤러·서비스·저장소 제공자를 등록하고 필요한 제공자를 명시적으로 내보낸다. 전역 `CommonModule`은 설정·Pino 로그·마이그레이션을 적용한 SQLite 연결을 `CONFIG`, `LOGGER`, `DB` 토큰으로 제공한다. 비클래스 의존성은 토큰으로 주입하며 서비스 클래스는 타입으로 주입한다. SQL 마이그레이션은 `001_core`, `002_auth`, `003_jobs`, `004_chat`, `005_dreaming`, `006_rag` 순서다. 벡터 테이블은 임베딩 차원 설정에 맞춰 RAG 모듈이 런타임에 생성한다.

HTTP 진입점은 Nest 애플리케이션을 만들고 Next를 준비한 뒤 같은 프로세스에서 초기 검색 인덱스 동기화를 백그라운드로 시작하고 쓰기 워커와 dreaming을 명시적으로 시작한다. CLI는 필요할 때 Nest 애플리케이션 컨텍스트를 만들고 모듈별 관리 명령에서 서비스를 조회하며 HTTP 서버·쓰기 워커·dreaming 스케줄러를 시작하지 않는다. Nest 종료 훅은 `SIGINT`와 `SIGTERM`에서 서비스와 서버를 정리하고 DB 연결을 닫도록 한다. 요청 분기와 MVC 경계는 [엔진 아키텍처](architecture.md#nestjs와-nextjs의-mvc-경계)에 기록한다.
종료 전에는 초기 인덱스 동기화가 끝나기를 기다린다. Nest의 역방향 모듈 종료 순서에서 전역 `CommonModule`이 마지막에 DB를 닫으므로, 기능 서비스의 종료 훅은 작업 중단을 끝까지 기다려야 한다. Next 핸들러도 애플리케이션 종료 훅에서 닫는다.

공용 `ZodValidationPipe`는 검증과 Zod 변환 결과를 컨트롤러에 전달한다. 전역 `HttpExceptionFilter`는 HTTP 예외·Zod 검증 오류·도메인의 `status`와 `code` 오류를 `{ error: { code, message } }`로 반환한다. 예상하지 못한 오류는 500과 `internal_error`로 처리하고 내부 메시지를 노출하지 않는다. `/healthz`는 `{ ok: true }`를 반환한다.
Zod 검증 실패는 400과 `invalid_input`을 반환한다. 메시지는 각 오류를 점으로 연결한 `path: message`로 표현하고 여러 오류를 `; `로 연결하며, 경로 없는 오류는 기존 API 계약과 같은 `input: message`를 사용한다. 오류 객체의 숫자 `status`가 400~599이면 해당 상태를 보존하고, 문자열 `code`가 없는 500 이외 오류는 `bad_request`를 사용한다.

HTTP 진입점과 Nest 테스트 앱은 `src/common/http/configure-app.ts`의 `configureApp(app)`을 초기화와 수신 시작 전에 적용한다. OAuth 본문은 URL-encoded와 JSON 모두 64kb로 제한하며, URL-encoded 필드는 `extended: false`로 파싱한다. 이후 공용 JSON·`extended: true` URL-encoded 파서를 명시적으로 등록해 다른 백엔드 경로에는 기본 100kb 제한을 유지한다. Nest의 파서 중복 검사는 경로가 아니라 미들웨어 이름만 확인하므로 OAuth 전용 파서만 등록하면 다른 경로의 본문 파싱이 사라지는 함정이 있다. OAuth 제한을 넘는 본문은 413과 `bad_request`를 반환한다.

### 루트 스크립트와 빌드 자산
| 명령 | 동작 |
| --- | --- |
| `pnpm dev` | `node --import @swc-node/register/esm-register src/main.ts`로 Nest와 Next 개발 모드를 한 프로세스에서 실행한다. |
| `pnpm build` | `next build web` 후 `tsc`로 서버를 컴파일하고 `scripts/build-assets.mjs`로 서버 자산을 복사한다. |
| `pnpm start` | `node dist/main.js`로 서버를 실행하며 `NODE_ENV=production`에서 빌드된 Next 앱을 제공한다. |
| `pnpm cli <명령>` | `node --import @swc-node/register/esm-register src/cli.ts`로 로컬 관리 명령을 실행한다. |
| `pnpm typecheck` | 서버와 `web/tsconfig.json`의 웹 타입을 모두 검사한다. |
| `pnpm test` | 데코레이터 메타데이터를 생성하는 SWC 변환을 적용해 Vitest를 실행한다. |

빌드 결과에는 `dist/main.js`, `dist/cli.js`, `dist/db/migrations/*.sql`, `dist/knowledge/seed/`와 `web/.next/`가 들어간다. SQL과 seed는 TypeScript 컴파일만으로 생성되지 않으므로 자산 복사 단계를 생략하지 않는다. 실행 시에는 루트 운영 의존성, Next 설정, `web/public/`도 필요하다. 웹은 항상 함께 빌드하며 Next standalone 출력이나 별도 웹 서버를 사용하지 않는다.

### OpenAI 로컬 테스트 fixture
`test/fake-openai.ts`의 `startFakeOpenAI(script?: readonly FakeTurn[])`는 `Promise<{ url, close, requests }>`를 반환한다. 서버는 루프백 주소의 임시 포트를 사용하며 `url`에는 이미 `/v1`이 포함된다. OpenAI SDK의 `baseURL` 또는 엔진의 `OPENAI_BASE_URL`에 그대로 전달하고 테스트 종료 시 `await close()`로 정리한다.

`script`는 `/v1/responses` 요청마다 한 턴씩 소비하는 큐다. 턴은 문자열, `{ text }`, `{ functionCalls, text? }`, `{ output }` 형식을 지원한다. `functionCalls`의 각 호출은 `name`, JSON 문자열이나 객체인 `arguments`, 선택적인 `call_id`를 가지며 `output` 배열은 텍스트와 함수 호출을 함께 담을 수 있다. 일반 응답과 SSE 스트리밍 응답을 모두 제공한다. 큐가 소진되면 임의의 답을 생성하지 않고 HTTP 400과 `fake_script_exhausted` 오류를 반환한다.

`requests`는 메서드·경로·요청 본문을 순서대로 기록하므로 에이전트가 도구 결과를 다음 요청에 넘겼는지 확인할 수 있다. `/v1/embeddings`는 SHA-256으로 시드한 결정론적 정규화 벡터를 반환하고 응답 큐를 소비하지 않는다. 요청의 `dimensions`를 사용하며 기본값은 1536이다. float 배열과 base64 인코딩을 지원한다.

fixture의 범위를 검증하는 명령은 `pnpm vitest run test/fake-openai.test.ts`다. 이 fixture는 OpenAI API의 유료 호출이나 외부 네트워크 없이 도구 호출과 스트리밍을 재현하기 위한 것이며 실제 모델 품질을 평가하지 않는다.

### 환경 변수
설정은 프로세스 환경 변수에서 읽는다. 키와 비밀값은 저장소나 이미지에 넣지 않고 실행 시 전달한다.

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `NODE_ENV` | `development` | Docker 이미지는 `production`으로 설정한다. Next 개발 모드 선택, 개발 로그인 허용 여부와 세션 설정에 영향을 준다. |
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

export DATA_DIR="$PWD/data"
export NODE_ENV=development
export SESSION_SECRET="$(openssl rand -hex 32)"
pnpm cli user add admin@example.com --role admin
DEV_LOGIN_EMAIL=admin@example.com pnpm dev
```

`pnpm dev` 하나로 API와 UI를 함께 실행하므로 별도 UI 개발 서버를 띄우지 않는다. 서버가 준비되면 `http://localhost:3000/auth/dev-login`에 접근해 등록한 관리자 세션을 만든다. 개발 로그인은 Google 없이 로컬 화면을 확인하기 위한 접점이며 신규 사용자를 자동 생성하지 않는다. 사용자 이메일은 CLI로 미리 등록해야 한다. API 키 없이 로컬 인증과 저장소를 확인할 수 있지만 Luna의 응답과 임베딩을 확인하려면 `OPENAI_API_KEY`가 필요하다.

빌드된 서버와 웹을 확인할 때는 `pnpm build` 후 `NODE_ENV=production pnpm start`를 사용한다. 이 모드에서는 개발 로그인을 사용할 수 없으므로 Google 로그인 설정이 필요하다. 관리자 권한 복구는 `pnpm cli user role admin@example.com admin`으로 수행한다. 첫 관리자 이후의 사용자·권한·허용 도메인 설정은 웹 관리 화면에서 변경하며 정책은 [인증](auth.md)에 기록한다.

### Docker 이미지와 영속 볼륨
Dockerfile은 `node:24-bookworm-slim` 기반의 두 단계 빌드를 사용한다. 빌드 단계에서 루트 의존성을 frozen lockfile로 한 번 설치하고 `pnpm build`를 실행한 뒤 개발 의존성을 제거한다. 실행 단계에는 서버와 Next에 필요한 루트 운영 의존성, `dist/`, `web/.next/`, `web/public/`, Next 설정을 복사하며 git, openssh-client, tini를 설치한다. Nest와 Next를 같은 Node 프로세스에서 실행하므로 Next standalone 서버나 별도 웹 컨테이너는 사용하지 않는다.

실행 사용자는 root가 아닌 `node`다. tini가 PID 1에서 신호와 자식 프로세스를 처리하며 `node dist/main.js`를 실행한다. `llmwiki` 실행 파일은 `PATH`에 있으므로 컨테이너 안에서도 관리 명령을 직접 호출할 수 있다. `/healthz`는 설정된 HTTP 포트에서 이미지의 healthcheck에 사용한다.

다음은 **로컬 이미지 확인용** 예시다. 이미지는 `NODE_ENV=production`에서 빌드된 Next 앱을 제공하므로 개발 모드로 덮어쓰거나 `DEV_LOGIN_EMAIL`을 전달하지 않는다. Google 로그인까지 확인하려면 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, 등록된 리디렉션 주소에 맞는 `PUBLIC_URL`을 실행 환경으로 추가한다.

```bash
docker build -t llmwiki-engine:local .
docker volume create llmwiki-local-data
export LOCAL_SESSION_SECRET="$(openssl rand -hex 32)"
docker run -d --name llmwiki-local \
  -p 127.0.0.1:3000:3000 \
  -v llmwiki-local-data:/data \
  -e SESSION_SECRET="$LOCAL_SESSION_SECRET" \
  llmwiki-engine:local
docker exec llmwiki-local llmwiki user add admin@example.com --role admin
curl --fail http://localhost:3000/healthz
```

관리자를 등록한 뒤 Google 로그인 설정이 있는 경우 `PUBLIC_URL`의 `/auth/google/login`을 연다. Google 없는 개발 로그인은 앞의 로컬 소스 실행 절차를 사용한다. 이미지 실행에 OpenAI 기능이 필요하면 `OPENAI_API_KEY`를 실행 환경으로 전달한다. `/data`를 named volume으로 보존하면 컨테이너를 다시 만들어도 지식과 SQLite 상태를 유지한다. 호스트 디렉터리를 bind mount할 경우 이미지의 `node` 사용자 UID/GID가 쓰기 가능한 권한을 미리 설정해야 한다. 볼륨 전체 백업과 지식 저장소의 git 원격 백업은 서로 다른 범위를 보호한다.

SSH 키는 이미지에 복사하지 않는다. 원격 git이 필요할 때는 키와 검증된 `known_hosts`를 실행 사용자에게 읽기 가능한 읽기 전용 마운트로 제공하고 `GIT_SSH_KEY_PATH`를 설정한다. `.dockerignore`는 git 메타데이터, 설치·빌드 결과, 로컬 데이터, 환경 파일, SSH 디렉터리와 키 파일을 빌드 컨텍스트에서 제외한다.

## 관련 문서
- [엔진 아키텍처](architecture.md)는 단일 컨테이너와 SQLite 선택의 배경을 설명한다.
- [인증](auth.md)은 관리자 부트스트랩 이후 적용되는 사용자와 로그인 정책을 설명한다.
- [지식 저장소](knowledge-repository.md)는 영속 지식의 구조와 원격 백업 범위를 설명한다.
- [웹](web.md), [MCP](mcp.md), [RAG](rag.md)는 각 모듈의 외부 계약을 설명한다.
