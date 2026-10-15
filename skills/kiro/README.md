# Kiro 설치 자료
Kiro에 llmwiki Skill을 설치하고 MCP OAuth를 별도로 연결하는 자료다.

## 배경
공통 프롬프트의 단일 원본은 `skills/llmwiki/SKILL.md`다. 이 디렉터리는 셸·CLI 설치 시 Skill의 `client/`에 복사된다. `mcp.example.json`은 병합용 예시이며 활성 설정이 아니다. Skill 설치, MCP 등록, 브라우저 OAuth 로그인은 별개다.

## 내용
### 설치와 갱신
엔진의 공개 주소로 macOS·Linux에서 다음 명령을 실행한다. `<ENGINE_URL>`은 실제 엔진 기본 주소로 바꾼다. Node.js·pnpm·Python이나 엔진 빌드는 필요 없다.

```bash
curl -fsSL <ENGINE_URL>/skills/install.sh | sh -s -- install kiro
```

저장소를 이미 받았다면 배포 자료를 갱신한 뒤 루트에서 다음 명령을 실행한다.

```bash
sh skills/install.sh install kiro
sh skills/install.sh status kiro
sh skills/install.sh update kiro
sh skills/install.sh install kiro --project /path/to/project
```

[공식 Skills 문서](https://kiro.dev/docs/skills.md)에 따라 개인 대상은 `~/.kiro/skills/llmwiki`, 프로젝트 대상은 `<dir>/.kiro/skills/llmwiki`다. 각 디렉터리의 `SKILL.md`는 필수 frontmatter인 `name`과 `description`을 포함하며 공통 원본이 두 필드를 제공한다. 새 세션에서 관련 작업에 자동 적용하거나 `/llmwiki`로 호출한다. 같은 이름이면 프로젝트 Skill이 개인 Skill보다 우선한다. 사용자 정의 에이전트는 기본적으로 Skill을 읽지 않으므로 공식 문서에 따라 에이전트의 `resources`에 해당 `skill://` 경로를 별도로 등록한다. 개인 경로는 로컬 IDE·CLI용이며 Kiro Web의 개인 설정과 구분한다.

셸과 기존 `llmwiki skill install|status|update kiro` CLI는 `.llmwiki-install.json` 버전·관리 파일 SHA-256 표식과 수정 보호를 공유한다. 프로젝트 상태 조회·갱신에도 같은 `--project`를 사용한다. 로컬 수정·삭제와 표식 없는 기존 파일은 기본적으로 덮어쓰지 않는다. 검토·백업 후 `--force`로 Skill 파일만 교체하며 관계없는 추가 파일은 보존한다. 심볼릭 링크와 디렉터리는 강제로 교체하지 않는다. 셸·CLI가 관리하는 설치 위치에 다른 설치 경로를 겹쳐 사용하지 않는다.

### 별도 MCP 연결과 OAuth
[공식 MCP 설정 문서](https://kiro.dev/docs/mcp/configuration.md)에 따라 개인 `~/.kiro/settings/mcp.json` 또는 프로젝트 `.kiro/settings/mcp.json`의 기존 `mcpServers`에 `mcp.example.json`의 `llmwiki` 항목만 병합한다. 기존 서버와 다른 설정은 보존하며 같은 이름의 항목이 있으면 중복 선언하지 않고 수정한다. 예시의 `url`을 실제 엔진 기본 주소에 `/mcp`를 붙인 값으로 바꾼다. 원격 Streamable HTTP 연결은 `url`을 사용한다.

Kiro는 연결 시 OAuth를 자동 발견하고 DCR로 등록하므로 정적 토큰·클라이언트 비밀값을 예시에 넣지 않는다. [공식 원격 MCP 안내](https://kiro.dev/blog/introducing-remote-mcp/)에 따라 IDE에서는 설정 저장 후 나타나는 인증 알림을 선택하고 외부 웹사이트 열기를 허용한 뒤 브라우저 로그인을 완료한다. CLI도 연결 시 브라우저 OAuth 흐름을 진행한다. 만료·폐기된 자격 증명의 재인증은 CLI 대화 안에서 [공식 `/mcp auth` 명령](https://kiro.dev/docs/reference/slash-commands.md#mcp-auth)의 `/mcp auth llmwiki`를 사용한다.

새 세션에서 실제 검색과 노트 읽기로 연결을 확인한다. Skill 목록 표시만으로 MCP 연결 성공을 판단하지 않는다. 설치기는 활성 MCP 설정과 OAuth 저장소를 수정하지 않으며 `--force`도 이 경계를 바꾸지 않는다.

## 관련 문서
- 저장소의 `docs/skills.md`는 설치 위치, 버전·해시 표식과 수정 보호를 설명한다.
- 저장소의 `docs/mcp.md`와 `docs/auth.md`는 도구와 인증 계약을 설명한다.
