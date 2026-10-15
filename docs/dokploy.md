# Dokploy 배포
Dokploy의 **Application** 유형으로 Dockerfile을 빌드하고 엔진 하나의 도메인·비밀값·영속 데이터와 안전한 교체 순서를 설정하는 절차다.

## 배경
엔진은 [단일 컨테이너·단일 Node 프로세스](architecture.md)로 운영한다. Dokploy의 Application은 Docker Swarm 서비스이며 기본 업데이트 순서와 롤백 순서가 모두 `start-first`다. 이 기본값에서는 배포할 때뿐 아니라 실패 후 롤백할 때도 이전 엔진과 새 엔진이 같은 `/data`를 동시에 사용할 수 있다. 엔진의 [git 머지 직렬화](knowledge-repository.md#격리-편집과-복구)는 프로세스 내부에서만 작동하고 작업 큐·꿈꾸기 스케줄러·인덱서도 프로세스마다 실행된다. 프로세스 간 잠금이 없으므로 **Replicas를 `1`로 유지하고 Update Config와 Rollback Config를 모두 `stop-first`로 설정해야 한다**. 저장소의 Dockerfile은 Swarm의 교체 순서를 정할 수 없으므로 운영자가 Dokploy UI에서 두 설정을 직접 저장한다.

이미지의 HEALTHCHECK는 **`/healthz` 생존 확인**을 사용한다. Swarm은 healthcheck가 있는 태스크가 healthy가 되어야 서비스 트래픽을 전달하고, unhealthy 태스크를 교체한다. `/readyz`는 긴 최초 색인 중이거나 OpenAI 등 임베딩 API 장애로 인덱서 오류가 남으면 `503`을 반환하므로 이를 이미지 healthcheck로 쓰면 색인을 끝내기 전에 재시작을 반복하거나 외부 API 장애가 로그인·관리 화면의 접속 장애로 번진다. `/readyz`는 별도 준비 상태 모니터링에 계속 사용한다. 최초 색인 실패 뒤 재시작이 필요한 경우를 포함한 상태 계약은 [생존과 준비 상태](operations.md#생존과-준비-상태)를 따른다.

## 내용
### 빌드와 접속 경계
루트 `Dockerfile`로 이미지를 빌드한다. 이미지 구성과 로컬 이미지 확인용 `compose.yaml`의 `dev` 프로필은 [개발 환경](development.md#docker-이미지와-영속-볼륨)에 기록한다. 운영 Application에 로컬 Compose 프로필을 적용하지 않는다.

컨테이너 수신 포트는 `3000`이며 Dokploy의 Traefik이 `dokploy-network`를 통해 Swarm 서비스로 연결한다. **Ports를 추가하지 않고** Domains만 설정한다. `TRUST_PROXY=true`는 서버에 직접 접근할 수 없고 신뢰하는 프록시만 연결하는 이 경계에서만 안전하다. 호스트 포트를 공개하면 클라이언트가 전달 IP를 위조할 수 있으므로 이 설정과 함께 직접 접속 경로를 열지 않는다.

### 환경변수 준비
전체 변수의 기본값·검증·제공자별 모델 규칙은 [개발 환경의 환경 변수 표](development.md#환경-변수)를 단일 기준으로 삼는다. 아래는 이 배포에서 운영자가 명시할 값이다. 비밀값은 git 저장소·Dockerfile·이미지에 넣지 않고 **Environment**에 저장한다.

- `SESSION_SECRET`은 production 시작에 필수다. 신뢰하는 로컬 터미널에서 `openssl rand -hex 32`로 생성한 비밀값을 넣고 재배포 때도 유지한다.
- `PUBLIC_URL`은 사용자가 실제로 접속할 정확한 외부 HTTPS 주소로 지정한다. 예시는 `https://wiki.example.com`이며 내부 컨테이너 주소나 `http://localhost:3000`을 넣지 않는다. 경로 접두사가 없는 루트 주소를 사용하고 끝의 `/`는 생략한다.
- `LLM_PROVIDER`, `OPENAI_API_KEY`, `LLM_MODELS`는 도니와 임베딩을 사용할 운영 구성에 맞춰 명시한다. 제공자는 `openai` 또는 `openrouter`이며 API 키와 모델은 선택한 제공자에서 사용할 수 있어야 한다. 이 세 값이 모두 설정 스키마의 무조건 필수 항목인 것은 아니다. 제공자·모델에는 기본값이 있고 API 키 없이도 인증 서버는 시작하지만 도니와 임베딩의 API 호출은 실패한다.
- `TRUST_PROXY=true`를 지정한다. 이 값의 안전 조건은 [빌드와 접속 경계](#빌드와-접속-경계)를 따른다.
- 원격 지식 백업에는 `KNOWLEDGE_REPO_URL=git@github.com:org/repo.git` 같은 SSH 주소와 `GIT_SSH_KEY_PATH=/run/secrets/llmwiki/knowledge_deploy_key`를 권장한다. 이는 엔진 소스 저장소가 아니라 별도의 지식 저장소 주소다. 원격을 생략할 때의 로컬 저장소 동작과 원격 push 범위는 [지식 저장소](knowledge-repository.md#main과-github-백업)를 따른다.
- Google 로그인이 필요하면 `GOOGLE_CLIENT_ID`와 `GOOGLE_CLIENT_SECRET`을 함께 지정한다. Google OAuth 클라이언트의 승인된 리디렉션 URI에는 `${PUBLIC_URL}/auth/google/callback`을 등록한다. 예시는 `https://wiki.example.com/auth/google/callback`이다. Google 설정은 이메일·비밀번호 로그인에 필수가 아니다.
- `NODE_ENV`, `DATA_DIR`, `PORT`는 Environment에 넣지 않는다. 이미지 ENV가 각각 `production`, `/data`, `3000`으로 고정한다. `DEV_LOGIN_EMAIL`도 넣지 않는다. 상용 모드에서는 개발 로그인을 허용하지 않는다.

### Dokploy 설정 절차
아래 단계는 운영자가 Dokploy에서 수행하는 절차이며 저장소 작업이나 로컬 이미지 확인 과정에서 자동 실행하지 않는다. 탭과 고급 설정의 구분은 공식 [Applications 문서](https://docs.dokploy.com/docs/core/applications)와 [Advanced 문서](https://docs.dokploy.com/docs/core/applications/advanced)를 따른다. 첫 Deploy 전에 교체 순서까지 모두 저장한다.

1. Dokploy의 프로젝트에서 **Create Service → Application**으로 서비스를 만든다. **General**에서 이 엔진의 소스 저장소와 배포할 브랜치를 Git provider로 연결한다. 비공개 소스 저장소의 체크아웃 권한은 Dokploy의 Git provider에 설정하며 아래 지식 저장소용 SSH 키와 별개다. **Build Type**은 **Dockerfile**, **Docker File**(Dockerfile Path)은 `Dockerfile`, **Docker Context Path**는 `.`으로 지정하고 저장한다. 경로 필드 이름은 [Dokploy 빌드 설정 UI](https://github.com/Dokploy/dokploy/blob/e0006758c0a812dc377113d8523abf72180d650b/apps/dokploy/components/dashboard/application/build/show.tsx#L397-L418)를 기준으로 표기한다.
2. **Environment**에 다음 블록을 복사하고 도메인·생성한 비밀값·실제 API 키와 사용 가능한 모델로 바꾼 뒤 저장한다. 주석 처리한 지식 저장소·Google 항목은 해당 기능을 구성할 때만 주석을 해제하고 실제 값으로 바꾼다. 예시 비밀값을 그대로 사용하지 않는다. 각 값의 의미는 [환경변수 준비](#환경변수-준비)를 따른다.

   ```dotenv
   SESSION_SECRET=replace-with-output-of-openssl-rand-hex-32
   PUBLIC_URL=https://wiki.example.com
   LLM_PROVIDER=openai
   OPENAI_API_KEY=replace-with-provider-api-key
   LLM_MODELS=gpt-6-luna
   TRUST_PROXY=true

   # KNOWLEDGE_REPO_URL=git@github.com:org/repo.git
   # GIT_SSH_KEY_PATH=/run/secrets/llmwiki/knowledge_deploy_key
   # GOOGLE_CLIENT_ID=replace-with-google-client-id
   # GOOGLE_CLIENT_SECRET=replace-with-google-client-secret
   ```

3. **Advanced → Volumes → Add Volume**에서 다음 마운트를 추가한다. 대화상자 제목은 **Volumes / Mounts**이며 유형은 **Volume** 또는 **File Mount**로 선택한다. `/data`의 Volume은 항상 필요하며 File Mount는 SSH 원격 지식 저장소를 사용할 때만 추가한다.

   | 유형 | 입력값 | Mount Path (In the container) |
   | --- | --- | --- |
   | Volume | Volume Name: `llmwiki-data` | `/data` |
   | File Mount | File Path: `knowledge_deploy_key` | `/run/secrets/llmwiki/knowledge_deploy_key` |

   File Mount의 내용에는 지식 저장소 전용 private deploy key 전체를 붙여 넣고 **마지막 줄 뒤에도 줄바꿈을 넣는다**. 공개 키는 GitHub 지식 저장소의 Deploy keys에 등록하고 **Allow write access**를 켠다. 엔진이 지식을 push하므로 읽기 전용 키로는 충분하지 않다. 환경변수의 `GIT_SSH_KEY_PATH`는 File Mount의 Mount Path와 일치시킨다. private key를 Environment의 여러 줄 값이나 이미지에 넣지 않는다.

   Dokploy는 File Mount 파일을 root 소유 `0644`로 만든다. OpenSSH는 키 파일의 소유자가 실행 사용자와 같을 때만 그룹·기타 권한을 거부하므로, 컨테이너의 `node`(UID 1000)는 root 소유 `0644` 키를 그대로 사용할 수 있다. 반대로 키를 `node` 소유로 바꾸면서 `0644`를 유지하면 `UNPROTECTED PRIVATE KEY FILE`로 거부되므로 호스트에서 소유자만 바꾸지 않는다.
4. **Domains**에서 실제 호스트 이름을 지정하고 컨테이너 포트를 `3000`으로 설정한다. HTTPS와 **Let's Encrypt** 인증서를 설정하며 해당 도메인의 DNS A 레코드가 Dokploy 서버의 공개 IP를 가리키게 한다. 도메인은 `PUBLIC_URL`과 일치시킨다.
5. **Advanced → Cluster Settings**의 **Replicas**를 `1`로 저장한다. 여러 복제본이나 Global 모드를 사용하지 않는다.
6. **Advanced → Swarm Settings**에서 **Update Config**와 **Rollback Config**를 각각 다음 JSON으로 저장한다. 한쪽만 설정하면 다른 경로에서 두 엔진이 겹칠 수 있다.

   **Update Config**:

   ```json
   {"Parallelism":1,"Order":"stop-first","FailureAction":"rollback"}
   ```

   **Rollback Config**:

   ```json
   {"Parallelism":1,"Order":"stop-first"}
   ```

   **Health Check**는 비워 둔다. 이미지의 `/healthz` HEALTHCHECK를 그대로 사용하며 `/readyz`로 덮어쓰지 않는다. 저장소 파일만으로 Update Config와 Rollback Config를 강제할 수 없으므로 두 필드에 저장한 값을 직접 확인한다.
7. **Advanced → Ports**에는 아무 항목도 추가하지 않는다. Domains의 `3000`은 Traefik의 컨테이너 연결 대상이지 호스트 공개 포트 설정이 아니다. `TRUST_PROXY=true`를 유지하려면 이 직접 접속 차단도 유지한다.
8. **Deploy**를 실행하고 **Deployments**의 빌드 로그와 **Logs**의 실행 로그를 확인한다. 환경변수 검증, 지식 저장소 초기화와 `llmwiki-engine listening` 로그를 살피고 초기 색인 실패 로그가 없는지 확인한다. UI 접근 가능 여부와 별도로 `${PUBLIC_URL}/readyz`를 모니터링한다. 이후 Cluster 등 실행 설정을 바꾸면 **Redeploy**로 적용하되 두 `stop-first` 설정과 단일 복제본을 유지한다.
9. Dokploy의 해당 **컨테이너 터미널**에서 아래 첫 명령으로 관리자를 등록한다. 서버의 Docker CLI를 사용하는 경우 두 번째 명령에서 `<container>`를 실제 실행 컨테이너 이름으로 바꾼다. 둘 중 하나만 실행한다.

   ```bash
   llmwiki user add admin@example.com --role admin --password
   # Dokploy 서버에서 실행하는 대안이다.
   docker exec -it <container> llmwiki user add admin@example.com --role admin --password
   ```

   `admin@example.com`은 관리자의 실제 이메일로 바꾼다. `--password`는 값을 받지 않는 플래그이며 비밀번호는 숨김 프롬프트에서 입력한다. 명령행 인자에 비밀번호를 적지 않는다. 첫 관리자 이후의 사용자 관리와 비상 복구는 [인증 문서](auth.md#첫-관리자-등록과-비상-복구)를 따른다.
10. `${PUBLIC_URL}/login`에서 등록한 이메일·비밀번호로 로그인한다. 외부 MCP 클라이언트의 서버 주소는 `${PUBLIC_URL}/mcp`이며 연결과 브라우저 OAuth 인증은 [설치형 Skills의 클라이언트 절차](skills.md#별도-mcp-연결과-oauth)를 따른다.

### 운영과 재배포 시 함정
#### 교체 순서와 단일 인스턴스
가장 위험한 실수는 **Update Config와 Rollback Config 중 하나라도 `stop-first`로 바꾸지 않는 것**이다. 업데이트만 고치면 평소 배포는 안전해 보여도 실패 후 자동 롤백에서 두 프로세스가 같은 `/data`를 사용한다. 작업이 중복 실행되거나 꿈꾸기·색인·git 머지가 동시에 진행되는 증상이 나타날 수 있으며, SQLite의 파일 잠금만으로 이 동시 실행을 막을 수 없다. 복제본 수 `1`만으로 교체 중 중첩을 방지할 수는 없다. 수동으로 띄우는 컨테이너도 같은 `/data`를 동시에 사용하지 않게 한다.

두 교체 순서를 `stop-first`로 설정하면 이전 태스크가 중지된 뒤 새 태스크가 시작하므로 **매 배포와 롤백에 짧은 서비스 중단이 있다**. Dokploy의 **Auto Deploy**를 켜면 연결한 브랜치의 push가 이 재배포를 유발하므로 무중단 배포로 간주하지 않는다.

#### 공개 주소와 인증
`PUBLIC_URL`은 단순한 화면 링크가 아니라 [Secure 세션 쿠키·CSRF Origin 검사·OAuth issuer와 MCP resource](auth.md)의 기준이다. 도메인을 바꾸면 Dokploy Domains와 DNS뿐 아니라 `PUBLIC_URL`도 갱신하고 재배포한다. Google 로그인을 사용하면 승인된 콜백 URI도 바꾼다. MCP 클라이언트에는 새 `${PUBLIC_URL}/mcp` 주소를 설정하고 다시 OAuth 인증을 수행한다. 주소 불일치는 로그인·변경 요청·MCP 인증 실패의 원인이 된다.

#### 데이터 볼륨과 백업
`llmwiki-data`는 manager 노드의 named Docker volume이며 `/data`의 지식 저장소·SQLite·업로드를 보존한다. 일반 재배포는 같은 볼륨을 유지하지만 볼륨을 삭제하면 데이터도 삭제된다. Volume Name을 바꾸면 별도의 빈 볼륨에 연결되어 기존 데이터가 보이지 않으며 데이터가 사라진 것처럼 보인다. 볼륨 이름 변경은 데이터 이전이 아니다.

Dokploy는 마운트가 있는 Application을 manager 노드에 배치한다. 이 설정에서 `/data`와 File Mount는 해당 manager의 로컬 저장소에 있으므로 다른 노드로 자동 복제되거나 장애 시 데이터가 함께 이동한다고 가정하지 않는다. 컨테이너 교체와 데이터 이전을 같은 작업으로 취급하지 않는다.

서비스 삭제·이전 전에는 [백업 생성·검증·오프라인 복원](backup.md) 절차를 사용하고 백업 파일을 해당 컨테이너와 볼륨 밖에 보관한다. 실행 중인 컨테이너에서 백업을 만드는 예시는 다음과 같다. `/safe/location`은 운영자가 준비한 안전한 호스트 경로로 바꾼다.

```bash
docker exec <container> llmwiki backup create --out /tmp/llmwiki-backup.zip
docker exec <container> llmwiki backup verify /tmp/llmwiki-backup.zip
docker cp <container>:/tmp/llmwiki-backup.zip /safe/location/llmwiki-backup.zip
```

Dokploy의 **Volume Backups**도 별도로 구성할 수 있지만 실행 중인 SQLite·git 파일을 그대로 복사하는 것이 일관된 애플리케이션 백업을 보장하지는 않는다. 엔진 백업과 원격 git 백업의 보호 범위, 복원 전 서버 중지와 비밀값 별도 보존은 [백업 문서](backup.md)를 따른다.

#### 빌드와 복사 데이터
이미지는 Dokploy 서버에서 Next.js 빌드와 네이티브 모듈 설치를 포함해 빌드하므로 런타임 사용량만 보고 서버 메모리를 정하지 않는다. 빌드에 충분한 RAM과 여유 공간을 확보하고 빌드 로그에서 메모리 부족을 확인한다.

데이터 볼륨을 초기화하거나 새 볼륨으로 바꾸면 지식 저장소 초기화와 최초 색인도 다시 수행한다. 색인 중 UI 접근과 검색 준비 상태가 같지 않은 이유는 [배경](#배경)에 기록한다.

운영 데이터를 복사해 검증용 서비스를 띄울 때는 별도 볼륨과 주소를 사용하고 `JOBS_AUTOSTART=false`를 지정한다. 대기 작업·예약 꿈꾸기·자동 색인의 재실행과 유료 API 호출을 막기 위한 설정이며 수동 요청까지 차단하는 스위치는 아니다. 상세 실행 경계는 [자동 실행 중지](operations.md#자동-실행-중지)를 따른다.

## 관련 문서
- [엔진 아키텍처](architecture.md)는 단일 프로세스와 SQLite·로컬 git 저장소의 경계를 설명한다.
- [개발 환경](development.md)은 환경변수의 전체 기준과 Docker 이미지·로컬 Compose 구성을 설명한다.
- [인증](auth.md)은 첫 관리자·웹 로그인·CSRF·Google과 MCP OAuth 정책을 설명한다.
- [백업과 복원](backup.md)은 일관된 백업·검증과 서버를 중지한 복원 절차를 설명한다.
- [설치형 Skills](skills.md)는 배포 이후 외부 MCP 클라이언트 연결과 OAuth 인증을 설명한다.
- [운영 상태와 관측](operations.md)은 생존·준비 상태와 자동 실행 중지·관리자 운영 접점을 설명한다.
- [지식 저장소](knowledge-repository.md)는 엔진 소스와 별개인 지식 저장소의 초기화·SSH 인증·원격 백업 범위를 설명한다.
