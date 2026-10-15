# Codex와 공유 Agent Skills 설치 자료
Codex와 같은 `.agents/skills`를 탐색하는 에이전트에 llmwiki Skill을 한 번만 설치하고, MCP OAuth는 사용하는 에이전트에서 별도로 연결하는 자료다.

## 배경
공통 프롬프트의 단일 원본은 `skills/llmwiki/SKILL.md`다. 이 디렉터리는 셸·CLI 설치 시 Skill의 `client/`에 복사된다. `mcp.example.toml`은 병합용 예시이며 활성 설정이 아니다. Skill 설치, MCP 등록, 브라우저 OAuth 로그인은 별개다.

## 내용
### 저장소만으로 설치와 갱신
다음 명령은 엔진 의존성 설치 없이 실행한다. Git, POSIX `sh`, 기본 파일·SHA-256 도구만 사용하며 Node.js, pnpm, Python과 빌드는 필요 없다. 비공개 저장소는 GitHub 접근 권한과 Git 인증을 먼저 준비한다.

```bash
git clone https://github.com/BitbyteCorp/llmwiki-engine.git \
  && sh llmwiki-engine/skills/install.sh install codex
```

개인 대상은 [공식 Skill 위치](https://developers.openai.com/codex/skills)인 `~/.agents/skills/llmwiki`이고 `--project <dir>`는 `<dir>/.agents/skills/llmwiki`를 선택한다. 이미 받은 저장소는 `git pull --ff-only`로 갱신한 뒤 루트에서 다음 명령을 사용한다.

Gemini CLI·OpenCode·Cursor·GitHub Copilot(VS Code와 CLI)·Windsurf/Devin Desktop·Roo Code·Amp·Goose·Factory Droid·Zed·Crush도 이 개인·프로젝트 공유 위치를 탐색한다. 이 에이전트에서 사용해도 설치 대상 ID는 `codex`이며 에이전트별 이름의 CLI 별칭을 만들지 않는다. 다른 클라이언트 전용 디렉터리에 같은 Skill을 중복 설치하지 않는다. 각 에이전트의 공식 위치·호출 방식과 MCP 설정은 저장소의 `docs/skills.md`를 따른다. 아래 Codex GitHub 기본 설치와 `codex mcp login`은 Codex에서만 사용하며 다른 에이전트에 실행하지 않는다.

```bash
sh skills/install.sh status codex
sh skills/install.sh update codex
sh skills/install.sh install codex --project /path/to/project
```

프로젝트 설치는 조회와 갱신에도 같은 `--project`를 사용한다. 기존 `llmwiki skill install|status|update codex`와 같은 `.llmwiki-install.json` 버전·관리 파일 SHA-256 표식과 수정 보호를 공유한다. 로컬 수정·삭제와 표식 없는 기존 파일은 기본적으로 덮어쓰지 않는다. 검토·백업 후 `--force`로 Skill 파일만 교체할 수 있으며 관계없는 추가 파일은 보존한다. 심볼릭 링크와 디렉터리는 강제로 교체하지 않는다. 자료나 README가 바뀐 릴리스도 `skills/version.json`과 Claude 플러그인·마켓플레이스 버전을 함께 올린다. 자세한 상태·보호 규칙은 `docs/skills.md`를 따른다.

### 기본 GitHub Skill 설치
[공식 Codex Skills 문서](https://developers.openai.com/codex/skills)에 따라 Codex 대화에서 `$skill-installer`에 정본 경로를 전달한다.

```text
$skill-installer install the skill from https://github.com/BitbyteCorp/llmwiki-engine/tree/main/skills/llmwiki
```

[OpenAI 공식 설치기 지침](https://github.com/openai/skills/blob/main/skills/.system/skill-installer/SKILL.md)은 `install-skill-from-github.py --repo BitbyteCorp/llmwiki-engine --path skills/llmwiki` 또는 같은 GitHub URL을 지원한다. 대상은 프롬프트가 없는 `skills/codex`가 아니라 `skills/llmwiki`다. Python 도우미의 기본 대상은 `$CODEX_HOME/skills`이며 기본값은 `~/.codex/skills`다. 셸·CLI의 `~/.agents/skills`와 다르며 원하는 설치 범위는 도우미의 `--dest`로 선택한다. Python 없이 설치하려면 저장소 전용 셸 경로를 사용한다. 존재하지 않는 `codex skills install` 명령을 사용하지 않는다.

기본 설치기는 기존 대상이 있으면 거부하며 `.llmwiki-install.json`을 만들지 않는다. 셸·CLI와 같은 대상에 겹쳐 설치하지 않는다. 새 Skill이 보이지 않으면 Codex를 다시 시작하고 `/skills` 또는 `$llmwiki`로 호출한다.

### 별도 MCP 연결과 OAuth
[공식 MCP 문서](https://developers.openai.com/codex/mcp)에 따라 기존 `~/.codex/config.toml` 또는 신뢰한 프로젝트의 `.codex/config.toml`에 `mcp.example.toml`의 `[mcp_servers.llmwiki]` 테이블을 병합한다. 예시 URL은 실제 엔진 기본 URL에 `/mcp`를 붙인 값으로 바꾼다. 기존 llmwiki 테이블이 있다면 중복 선언하지 않고 해당 값만 수정한다.

`codex mcp login llmwiki`로 브라우저 OAuth 로그인을 완료한다. 새 세션에서 `/mcp`로 서버 연결을 확인하고 실제 검색과 노트 읽기 결과를 확인한다. Skill 목록 표시만으로 연결 성공을 판단하지 않는다. 두 설치 경로 모두 MCP 설정이나 OAuth 토큰을 쓰지 않으며 `--force`도 이 경계를 바꾸지 않는다.

## 관련 문서
- 저장소의 `docs/skills.md`는 설치 위치, 버전·해시 표식, 수정 보호와 기본 배포 경로를 설명한다.
- 저장소의 `docs/mcp.md`와 `docs/auth.md`는 도구와 인증 계약을 설명한다.
