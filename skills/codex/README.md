# Codex 설치 자료
Codex에 llmwiki Skill을 설치하고 MCP OAuth를 별도로 연결하는 자료다.

## 배경
공통 프롬프트의 단일 원본은 `skills/llmwiki/SKILL.md`다. 이 디렉터리는 설치 시 Skill 디렉터리의 `client/`에 복사된다. `mcp.example.toml`은 병합용 예시이며 활성 설정이 아니다.

## 내용
`llmwiki skill install codex`는 [공식 Skill 위치](https://developers.openai.com/codex/skills)에 따라 `~/.agents/skills/llmwiki`에 설치한다. `--project <dir>`는 `<dir>/.agents/skills/llmwiki`를 선택한다. `llmwiki skill status codex`로 버전과 로컬 수정을 확인하고 `llmwiki skill update codex`로 갱신한다. 같은 프로젝트 옵션을 조회와 갱신에도 사용한다. 로컬 수정과 표식 없는 기존 파일은 기본적으로 보존하며 검토 후 `--force`로 Skill 파일만 교체한다.

[공식 MCP 문서](https://developers.openai.com/codex/mcp)에 따라 기존 `~/.codex/config.toml` 또는 신뢰한 프로젝트의 `.codex/config.toml`에 `mcp.example.toml`의 `[mcp_servers.llmwiki]` 테이블을 병합한다. 예시 URL은 실제 엔진 기본 URL에 `/mcp`를 붙인 값으로 바꾼다. 기존 llmwiki 테이블이 있다면 중복 선언하지 않고 해당 값만 수정한다. 설치기는 설정과 비밀값을 쓰지 않는다.

`codex mcp login llmwiki`로 브라우저 OAuth 로그인을 완료한다. 새 세션에서 `/mcp`로 서버 연결을 확인하고 `/skills` 또는 `$llmwiki`로 Skill을 호출한다. 실제 검색과 노트 읽기 결과를 확인하며 Skill 목록 표시만으로 연결 성공을 판단하지 않는다.

## 관련 문서
저장소의 `docs/skills.md`는 버전 표식, 수정 보호, 전체 설치 위치를 설명한다. `docs/mcp.md`와 `docs/auth.md`는 도구와 인증 계약을 설명한다.
