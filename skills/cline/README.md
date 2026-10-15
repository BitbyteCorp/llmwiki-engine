# Cline 설치 자료
Cline에 llmwiki Skill을 설치하고 MCP OAuth를 별도로 연결하는 자료다.

## 배경
공통 프롬프트의 단일 원본은 `skills/llmwiki/SKILL.md`다. 이 디렉터리는 셸·CLI 설치 시 Skill의 `client/`에 복사된다. `mcp.example.json`은 병합용 예시이며 활성 설정이 아니다. Skill 설치, MCP 등록, 브라우저 OAuth 로그인은 별개다.

## 내용
### 설치와 갱신
엔진의 공개 주소로 macOS·Linux에서 다음 명령을 실행한다. Node.js·pnpm·Python이나 엔진 빌드는 필요 없다.

```bash
curl -fsSL <ENGINE_URL>/skills/install.sh | sh -s -- install cline
```

저장소를 이미 받았다면 루트에서 다음 명령을 실행한다.

```bash
sh skills/install.sh install cline
sh skills/install.sh status cline
sh skills/install.sh update cline
sh skills/install.sh install cline --project /path/to/project
```

[공식 Skills 문서](https://docs.cline.bot/customization/skills)에 따라 개인 대상은 `~/.cline/skills/llmwiki`, 프로젝트 대상은 `<dir>/.cline/skills/llmwiki`다. Cline은 프로젝트의 `.clinerules/skills`와 `.claude/skills`도 탐색하지만 이 설치기는 두 범위에서 같은 Cline 전용 경로를 사용한다. 필수 frontmatter는 `name`과 `description`이며 공통 원본이 두 필드를 제공한다. 새 세션에서 관련 작업에 자동 적용하거나 채팅의 `/` 메뉴에서 `llmwiki`를 선택한다.

셸·CLI는 `.llmwiki-install.json` 버전·관리 파일 SHA-256 표식과 수정 보호를 공유한다. 로컬 수정·삭제와 표식 없는 기존 파일은 기본적으로 덮어쓰지 않는다. 검토·백업 후 `--force`로 Skill 파일만 교체하며 관계없는 파일은 보존한다. 심볼릭 링크와 디렉터리는 강제로 교체하지 않는다. 프로젝트 상태 조회·갱신에도 같은 `--project`를 사용한다.

### 별도 MCP 연결과 OAuth
[공식 MCP 문서](https://docs.cline.bot/mcp/mcp-overview)에 따라 Cline CLI의 `~/.cline/data/settings/cline_mcp_settings.json`에 `mcp.example.json`의 `llmwiki` 항목만 병합한다. `CLINE_MCP_SETTINGS_PATH`로 설정 파일을 변경할 수 있다. 확장 프로그램은 **MCP Servers → Configure → Configure MCP Servers**에서 별도 JSON을 열며 CLI와 같은 설정·인증 저장소라고 가정하지 않는다. 아래 로그인은 공식 문서가 명시한 CLI 절차다.

예시의 URL을 실제 엔진 기본 주소에 `/mcp`를 붙인 값으로 바꾼다. `type: "streamableHttp"`를 유지한다. `cline mcp`에서 `llmwiki` 서버의 **Authorize OAuth**를 선택하고 브라우저 로그인을 완료한다. 정적 토큰이나 OAuth 비밀값을 예시에 넣지 않는다. 새 세션에서 실제 검색과 노트 읽기로 연결을 확인한다.

설치기는 활성 MCP 설정과 OAuth 저장소를 수정하지 않으며 `--force`도 이 경계를 바꾸지 않는다.

## 관련 문서
- 저장소의 `docs/skills.md`는 설치 위치, 버전·해시 표식과 수정 보호를 설명한다.
- 저장소의 `docs/mcp.md`와 `docs/auth.md`는 도구와 인증 계약을 설명한다.
