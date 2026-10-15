# Hermes 설치 자료
Nous Research의 Hermes Agent에 llmwiki Skill을 설치하고 MCP OAuth를 별도로 연결하는 자료다.

## 배경
공통 프롬프트의 단일 원본은 `skills/llmwiki/SKILL.md`다. 이 디렉터리는 셸·CLI 설치 시 Skill의 `client/`에 복사된다. `mcp.example.yaml`은 병합용 예시이며 활성 설정이 아니다. Skill 설치, MCP 등록, 브라우저 OAuth 로그인은 별개다.

## 내용
### 저장소만으로 설치와 갱신
다음 명령은 엔진 의존성 설치 없이 실행한다. Git, POSIX `sh`, 기본 파일·SHA-256 도구만 사용하며 Node.js, pnpm, Python과 빌드는 필요 없다. 비공개 저장소는 GitHub 접근 권한과 Git 인증을 먼저 준비한다.

```bash
git clone https://github.com/BitbyteCorp/llmwiki-engine.git \
  && sh llmwiki-engine/skills/install.sh install hermes
```

개인 대상은 [공식 Skills 위치](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)인 `~/.hermes/skills/llmwiki`이고 `--project <dir>`는 `<dir>/.hermes/skills/llmwiki`를 선택한다. 이미 받은 저장소는 `git pull --ff-only`로 갱신한 뒤 루트에서 다음 명령을 사용한다.

```bash
sh skills/install.sh status hermes
sh skills/install.sh update hermes
sh skills/install.sh install hermes --project /path/to/project
```

Hermes는 `.git`이 있는 프로젝트 루트의 Skill을 탐색한다. `--project`에는 이 루트를 지정하고 설치 후 사용자가 별도로 `hermes skills trust <dir>`를 실행한다. 설치기는 프로젝트 신뢰 설정을 수정하지 않는다.

프로젝트 설치는 조회와 갱신에도 같은 `--project`를 사용한다. 기존 `llmwiki skill install|status|update hermes`와 같은 `.llmwiki-install.json` 버전·관리 파일 SHA-256 표식과 수정 보호를 공유한다. 로컬 수정·삭제와 표식 없는 기존 파일은 기본적으로 덮어쓰지 않는다. 검토·백업 후 `--force`로 Skill 파일만 교체할 수 있으며 관계없는 추가 파일은 보존한다. 심볼릭 링크와 디렉터리는 강제로 교체하지 않는다. 자료나 README가 바뀐 릴리스도 `skills/version.json`과 Claude 플러그인·마켓플레이스 버전을 함께 올린다. 자세한 상태·보호 규칙은 `docs/skills.md`를 따른다.

### 기본 GitHub Skill 설치
[공식 개별 GitHub 경로 설치](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills#installing-individual-skills-directly-without-adding-a-tap)에 따라 다음 명령을 사용한다.

```bash
hermes skills install BitbyteCorp/llmwiki-engine/skills/llmwiki
```

[공식 지원 소스 표](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills#supported-hub-sources)의 `github` 원본이며 대상은 `skills/hermes`가 아니라 `skills/llmwiki`다. 공개 저장소의 개별 경로는 tap 추가 없이 설치할 수 있다. 비공개 개별 경로의 직접 설치는 공식 문서에서 보장하지 않으므로, 비공개 저장소는 Git 인증으로 복제한 뒤 저장소 전용 셸 설치기를 사용한다. Hermes의 보안 검사·설치 확인·갱신 정책을 따르며 보안 검사 우회를 위해 `--force`를 권하지 않는다.

Hermes 기본 설치는 `.llmwiki-install.json`을 만들지 않으므로 셸·CLI와 같은 대상에 겹쳐 설치하지 않는다. 새 세션에서 `/llmwiki`를 호출한다. 기본 설치도 MCP 등록이나 OAuth 로그인을 대신하지 않는다.

### 별도 MCP 연결과 OAuth
[공식 MCP 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)에 따라 기존 `~/.hermes/config.yaml`의 `mcp_servers`에 `mcp.example.yaml`의 llmwiki 항목을 병합한다. 예시 URL은 실제 엔진 기본 URL에 `/mcp`를 붙인 값으로 바꾸고 `auth: oauth`를 유지한다. 기존 다른 서버 설정은 보존한다.

별도 터미널에서 `hermes mcp login llmwiki`로 브라우저 OAuth 로그인을 완료한다. 새 Hermes 세션에서 실제 검색과 노트 읽기 결과로 연결을 확인한다. `/reload-mcp`는 기존 세션의 MCP 재로드이며 새 Skill 반영과 구분한다. 브라우저와 Hermes가 다른 호스트에 있으면 공식 문서의 원격 콜백 절차를 따른다. 두 설치 경로 모두 MCP 설정이나 OAuth 토큰을 쓰지 않으며 셸·CLI의 `--force`도 이 경계를 바꾸지 않는다.

## 관련 문서
- 저장소의 `docs/skills.md`는 설치 위치, 버전·해시 표식, 수정 보호와 기본 배포 경로를 설명한다.
- 저장소의 `docs/mcp.md`와 `docs/auth.md`는 도구와 인증 계약을 설명한다.
