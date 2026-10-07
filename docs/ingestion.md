# 원문 수집
URL·PDF·텍스트·Markdown 파일·Obsidian 볼트·Notion 내보내기를 불변 원문과 출처 Markdown으로 보관한 뒤, 원문마다 Luna 통합 작업 하나를 실행한다.

## 배경
수집과 지식 통합은 서로 다른 단계다. 수집 단계는 다운로드·압축 해제·텍스트 추출을 수행하고 원문을 먼저 git에 저장한다. 통합 단계는 이미 커밋된 출처 Markdown을 Luna가 읽어 위키 노트를 정리하는 작업이다. 통합이 실패하더라도 원문 커밋은 보존하므로 원문의 출처와 실패 원인을 확인할 수 있다.

## 내용
### 입력과 권한
`IngestModule`은 `IngestService`를 내보내며 REST와 MCP가 같은 `ingest`를 사용한다.

```ts
await ingest.ingest({
  userId: 1,
  kind: 'url', // url | pdf | text | obsidian | notion | file
  url: 'https://example.com/article',
  instructions: '주요 개념을 기존 위키에 연결한다.',
}); // { importId, jobId }
```

`POST /api/imports`는 editor 이상이며, JSON에는 `userId` 없이 같은 필드를 전달한다. 세션 쿠키와 REST bearer 토큰을 지원한다. `url`, `uploadId`, `text` 중 하나만 전달하며 다음 규칙을 따른다.

| 종류 | 입력 | 처리 |
| --- | --- | --- |
| `url` | `url` | HTML 기사·PDF·UTF-8 텍스트·Markdown을 다운로드한다. |
| `pdf` | `url` 또는 `uploadId` | 실제 PDF 헤더를 확인하고 텍스트를 추출한다. |
| `text` | 비어 있지 않은 `text` | UTF-8 텍스트를 원문 그대로 보관한다. |
| `file` | `uploadId` | 업로드한 PDF·UTF-8 텍스트·Markdown을 추출한다. |
| `obsidian` | import 목적 ZIP의 `uploadId` | Markdown과 첨부 파일의 폴더 구조 및 위키링크를 유지한다. |
| `notion` | import 목적 ZIP의 `uploadId` | Markdown과 첨부 파일을 보관하며 경로와 링크의 내보내기 페이지 ID를 함께 제거한다. |

선택 필드 `filename`은 원문 파일명이고 `instructions`는 최대 10,000자의 요청자 지침이다. 업로드는 `POST /api/uploads`의 multipart `file`과 `purpose=import`로 먼저 생성한다. ZIP은 import 목적에서만 허용하며 해당 업로드를 만든 사용자만 수집할 수 있다. 채팅 첨부와 import ZIP은 서로 교환하지 않는다.

`GET /api/imports?limit=50&before=<importId>`는 `{ imports: [...] }`를 반환하며 viewer 이상이 자신의 기록만 조회한다. admin은 모든 사용자의 기록을 조회한다. `GET /api/imports/:id`도 같은 소유자/admin 규칙을 적용하며 다른 소유자의 기록은 404로 숨긴다. 기록은 `id`, `userId`, `kind`, `source`, `sha`, `status`, `rawPaths`, `jobId`, `error`, `createdAt`, `updatedAt`, `finishedAt`을 포함한다.

### 다운로드 보안과 한도
다운로더는 자격 증명이 없는 `http`와 `https`만 허용한다. DNS 응답 중 하나라도 사설·루프백·링크 로컬·공유 주소·비전역 주소이면 연결하지 않는다. IPv4 정수 표기와 IPv4-mapped IPv6도 URL 정규화와 주소 검사에서 차단한다. localhost, 로컬 도메인, 메타데이터 호스트, 메타데이터 주소와 IPv6 터널 주소도 차단한다.

각 리다이렉트에서 URL과 모든 DNS 응답을 다시 검사하고 최대 다섯 번만 따라간다. 검사한 IP를 실제 연결의 lookup에 고정하되 Host와 TLS SNI는 원래 호스트를 유지하므로 DNS 재바인딩을 허용하지 않는다. HTML의 이미지·iframe·스크립트·링크를 추가로 다운로드하지 않는다.

| 항목 | 한도 |
| --- | --- |
| URL 다운로드 총 시간 | DNS와 리다이렉트를 포함한 15초 |
| URL·PDF·텍스트·일반 파일 | 20 MiB |
| import JSON 인코딩된 요청 본문 | 21 MiB이며 추출된 원문은 별도로 20 MiB를 검사한다. |
| PDF | 최대 500페이지이며 OCR을 수행하지 않는다. |
| ZIP 압축 파일 | 100 MiB |
| ZIP 총 해제 크기 | 100 MiB |
| ZIP 개별 항목 | 20 MiB |
| ZIP 항목 수 | 디렉터리를 포함해 1,000개 |
| 리다이렉트 | 최대 5회 |

원격 Content-Type은 HTML/XHTML, PDF, text/plain, text/markdown만 허용하고 압축 HTTP 본문을 거부한다. Content-Length와 실제 스트림 바이트 수를 모두 검사한다. HTML은 linkedom으로 파싱한 뒤 Readability로 기사 본문을 골라 Turndown으로 Markdown을 만든다. 상대 HTTP 링크는 최종 URL을 기준으로 절대 주소로 바꾼다. PDF는 unpdf를 사용하며 추출할 텍스트가 없으면 오류를 반환한다.

ZIP은 fflate의 스트리밍 해제를 사용한다. 먼저 중앙 디렉터리를 검사하고 압축 조각을 작게 공급하며 선언 크기와 실제 해제 크기를 모두 검사한다. 절대 경로, `..`, 역슬래시, 제어 문자, `.git`, 중복 경로, symlink, 암호화, 다중 디스크 및 ZIP64를 거부한다. 서버 파일시스템에 ZIP 항목을 쓰지 않으며, `.obsidian` 같은 숨김 메타데이터와 `__MACOSX`는 위키 자료에서 제외한다. Notion ID 제거로 이름이 충돌하면 덮어쓰지 않고 전체 수집을 실패시킨다. 원문 문장에 있는 ID와 외부 URL은 바꾸지 않는다.

### 불변 원문과 커밋
원본 바이트의 SHA-256을 디렉터리 이름으로 사용한다.

```text
raw/<sha256>/
├── original/<filename>                 # 다운로드·업로드·텍스트 원본 바이트
├── extracted/<kind>/files/<vault-path> # ZIP의 Markdown과 바이너리 첨부
└── imports/<importId>.md               # 추출한 본문 또는 볼트 노트 목록과 출처
```

출처 Markdown의 frontmatter에는 import ID, 종류, 원래 source, 최종 URL, SHA-256, 파일명과 수집 시간을 기록한다. 본문은 불변 원문 링크와 추출 본문 또는 추출 노트 링크를 포함한다. 모든 새 원문·첨부·출처 Markdown은 `NoteWriterService.apply({ source: 'import', client: 'ingest' })` 한 번으로 커밋한다. 기존 raw 경로는 수정하지 않는다. 동일 원문을 다시 수집하면 git blob ID로 실제 바이트가 같은지 확인하여 기존 불변 자료를 재사용하고 별도의 출처 기록과 통합 작업을 생성한다. 대형 바이너리도 문자열로 읽지 않고 git 메타데이터와 입력 바이트의 blob 해시를 비교한다. 경로가 같으나 기존 바이트가 다르면 `409 raw_conflict`로 거부한다. git 커밋에는 일반 쓰기와 동일한 job/source/requester/client trailer가 들어간다.

### 통합 작업과 복구
원문마다 `source=import`인 Luna 작업 하나를 제출한다. 작업 입력에는 본문 전체를 붙이지 않고 커밋된 출처 Markdown 경로와 최대 10,000자의 지침만 전달한다. Luna는 출처 링크를 따라 필요한 자료를 읽고 원문을 지침으로 실행하지 않으며 raw 자료를 수정하지 않는다. 실제 통합 실행과 한도는 기존 [쓰기 흐름](write-flow.md)을 따른다.

`imports` SQLite 테이블은 수집 중 `extracting`, 제출 후 `queued`, 실행 중 `running`, 완료 후 `succeeded` 또는 `failed`를 기록한다. `job.updated` 이벤트가 상태를 갱신하고, 목록·상세 조회와 시작 시 저장된 write job 상태를 다시 확인하므로 놓친 이벤트도 복구한다. 작업 제출 전에 프로세스가 중단된 기록은 시작 시 실패로 바꾼다. source 수집 실패는 기록에 남고 REST는 해당 오류를 반환한다. 수집 제출의 `import.create`와 통합 완료의 `import.complete` 성공·실패 감사 기록에는 사용자, import ID, 종류만 남기며 원문 내용은 감사 요약에 넣지 않는다.

## 관련 문서
- [지식 저장소](knowledge-repository.md)는 raw 원문과 위키 노트의 저장 위치를 설명한다.
- [쓰기 흐름](write-flow.md)은 직접 원문 커밋과 Luna 통합 작업의 기록·머지 흐름을 설명한다.
- [인증](auth.md)은 editor/viewer 권한과 REST bearer 토큰을 설명한다.
- [MCP](mcp.md)는 같은 수집 기능을 호출하는 `ingest_source` 도구를 설명한다.
