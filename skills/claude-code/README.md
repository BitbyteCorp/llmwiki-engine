# Claude Code 설치 자료
Claude Code에 llmwiki 지침을 저장소 전용 설치기나 기본 플러그인 마켓플레이스로 설치하는 자료다.

## 배경
공통 프롬프트의 단일 원본은 `skills/llmwiki/SKILL.md`다. 이 디렉터리는 셸·CLI 설치 시 Skill의 `client/`에 복사되는 안내 자료이며 활성 MCP 설정이나 플러그인 루트가 아니다. Skill 설치, MCP 등록, 브라우저 OAuth 로그인은 별개다.

## 내용
### 저장소만으로 설치와 갱신
다음 명령은 엔진 의존성 설치 없이 실행한다. Git, POSIX `sh`, 기본 파일·SHA-256 도구만 사용하며 Node.js, pnpm, Python과 빌드는 필요 없다. 비공개 저장소는 GitHub 접근 권한과 Git 인증을 먼저 준비한다.

```bash
git clone https://github.com/BitbyteCorp/llmwiki-engine.git \
  && sh llmwiki-engine/skills/install.sh install claude-code
```

개인 대상은 `~/.claude/skills/llmwiki`이고 `--project <dir>`는 `<dir>/.claude/skills/llmwiki`를 선택한다. 이미 받은 저장소는 `git pull --ff-only`로 갱신한 뒤 루트에서 다음 명령을 사용한다.

```bash
sh skills/install.sh status claude-code
sh skills/install.sh update claude-code
sh skills/install.sh install claude-code --project /path/to/project
```

프로젝트 설치는 조회와 갱신에도 같은 `--project`를 사용한다. 기존 `llmwiki skill install|status|update claude-code`와 같은 `.llmwiki-install.json` 버전·관리 파일 SHA-256 표식과 수정 보호를 공유한다. 로컬 수정·삭제와 표식 없는 기존 파일은 기본적으로 덮어쓰지 않는다. 검토·백업 후 `--force`로 Skill 파일만 교체할 수 있으며 관계없는 추가 파일은 보존한다. 심볼릭 링크와 디렉터리는 강제로 교체하지 않는다. 자료나 README가 바뀐 릴리스도 `skills/version.json`, 플러그인 `version`, 마켓플레이스 `metadata.version`을 함께 올린다. 자세한 상태·보호 규칙은 `docs/skills.md`를 따른다.

### 기본 마켓플레이스 설치
[공식 마켓플레이스 문서](https://code.claude.com/docs/en/plugin-marketplaces)에 따라 Claude Code에서 다음 명령을 실행한다.

```text
/plugin marketplace add BitbyteCorp/llmwiki-engine
/plugin install llmwiki@llmwiki-engine
```

셸에서는 `claude plugin marketplace add https://github.com/BitbyteCorp/llmwiki-engine.git`와 `claude plugin install llmwiki@llmwiki-engine`을 사용한다. 기본 사용자 범위 대신 프로젝트 범위가 필요하면 설치 명령에 `--scope project`를 지정한다. 갱신은 `claude plugin marketplace update llmwiki-engine` 다음 `claude plugin update llmwiki@llmwiki-engine`으로 수행한다.

루트 `.claude-plugin/marketplace.json`의 `source: "./skills"`는 `skills/`만 플러그인 캐시 대상으로 삼는다. `skills/.claude-plugin/plugin.json`의 `skills: ["./llmwiki"]`는 캐시 안의 정본을 직접 찾는다. [공식 마켓플레이스 참조](https://code.claude.com/docs/en/plugins/marketplace-reference)와 [manifest 참조](https://code.claude.com/docs/en/plugins-reference)가 허용하는 경로이며 `strict: true`에서 구성 요소를 manifest 한 곳에만 선언한다. 엔진 저장소 전체, 데이터·의존성 디렉터리, `../` 참조나 임시 플러그인을 사용하지 않는다. 프롬프트 복제본과 자동 등록용 `.mcp.json`도 없다.

새 세션의 플러그인 호출은 이름 공간이 붙은 `/llmwiki:llmwiki`다. 셸·CLI 설치의 독립 Skill은 `/llmwiki`다. 두 경로를 중복 설치하지 않는다. 마켓플레이스 설치·갱신은 Claude가 관리하며 셸·CLI의 설치 표식을 만들지 않는다.

### 별도 MCP 연결과 OAuth
[공식 MCP 문서](https://code.claude.com/docs/en/mcp)에 따라 실제 엔진의 공개 기본 URL로 별도 등록한다.

```bash
claude mcp add --transport http --scope user llmwiki "<ENGINE_URL>/mcp"
```

프로젝트 연결은 `--scope project`를 사용하며 기존 서버 설정은 보존한다. Claude Code의 `/mcp`에서 브라우저 OAuth 로그인을 완료한 뒤 실제 검색과 노트 읽기를 실행한다. Skill이나 플러그인 설치는 서버를 자동 등록하거나 OAuth 토큰을 저장하지 않는다. `LLMWIKI_URL` 환경변수도 필요 없다.

## 관련 문서
- 저장소의 `docs/skills.md`는 설치 위치, 버전·해시 표식, 수정 보호와 기본 배포 경로를 설명한다.
- 저장소의 `docs/mcp.md`와 `docs/auth.md`는 도구와 인증 계약을 설명한다.
