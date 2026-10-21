# oil.chrome — 설계 초안 v1 (2026-10-20)

크롬의 창·탭 그룹·탭과 북마크 트리를 **들여쓰기 아웃라인 한 버퍼**로 보여주고, vim 키로 고친 뒤 `:w` 하면 확인창에 모든 액션을 띄우고 반영한다.
모델은 [tmux-oil.nvim](https://github.com/minhyeoky/tmux-oil.nvim)과 같다 — 버퍼가 desired state이고, 줄의 정체는 숨은 앵커가 지고, 휴리스틱은 없다.

## 1. 형태

- **MV3 확장 하나**다. 단축키·툴바 버튼이 popup 타입 창을 띄우고, 그 안에 CodeMirror 6 + `@replit/codemirror-vim` 편집기가 뜬다.
- 엔진(`src/core/`)은 chrome API를 모르는 순수 함수다 — `render(snapshot) → text`, `plan(base, fresh, text) → actions`.
  - nvim 프론트엔드(native messaging 브리지)를 나중에 붙여도 엔진은 그대로 쓴다.
- 기각: nvim 단독형(확장 + native host + nvim 플러그인 3단 설치, 탭 정리는 브라우저에 있을 때 하는데 터미널로 가야 한다), CDP(Chrome 136+는 기본 프로필에 원격 디버깅을 막는다·북마크 API 없음), AppleScript(macOS 전용·탭 그룹 없음).

### 선행 사례 (2026-10-20 조사)

- [oil.tabs](https://github.com/hamzahshahbazkhan/oil.tabs) — 같은 발상(CM6 + codemirror-vim, `:w`)의 미공개 MV3 프로토타입이다. 탭·창만 다루고, 그룹 편집은 넣었다가 뺐고, 북마크는 "북마크하고 닫기" 단방향(`:bm`)이다.
- [brotab](https://github.com/balta2ar/brotab) `bt move` — `$EDITOR`로 탭 목록을 고쳐 재배치·닫기·창 이동을 반영한다. 크롬 확장이 MV2라 Chrome 139+에서 돌지 않는다.
- TabFS — 탭을 FUSE 파일시스템으로 마운트한다. 삭제(닫기)만 되고 MV2다.
- 탭 + 그룹 + 북마크 트리를 한 버퍼에서 `:w`로 반영하는 도구는 찾지 못했다.

## 2. 버퍼 문법

```
line    := indent anchor? content
indent  := ' '*                        (\t 는 2칸)
anchor  := '/' kind id ' '              kind ∈ w g t b, id = [0-9]+
content := folder | entry | ''
folder  := name '/'                     (마지막 토큰이 URL이 아니고 '/'로 끝난다)
entry   := (title ' ')? url | title
url     := 마지막 공백 구분 토큰이 /^[A-Za-z][A-Za-z0-9+.\-]*:\S+$/ 에 맞으면 URL
```

- 앵커는 줄 맨 앞(들여쓰기 뒤)에서만 읽는다. 렌더 시 숨김(conceal) + atomic이다.
- 폴더 이름은 끝의 `/` 하나만 뗀다 — 제목이 `foo/`인 폴더는 `foo//`로 렌더된다.
- 이름의 마지막 토큰이 URL로 읽히는 폴더(`Re:`)는 `Re: /`로 렌더한다.
- `host:port[/path]` 꼴 URL 토큰(`localhost:3000` `example.com:8080`)은 스킴 없는 주소다.
  - 크롬에 쓸 때(새 탭·새 북마크·탭 이동·북마크 URL 수정) 스킴을 붙인다 — `localhost`·`*.localhost`·IPv4는 `http://`, `host.tld`(끝 라벨이 영문 2자 이상)는 `https://`.
  - 고치지 않은 줄은 저장된 URL과 글자 그대로 비교한다 — 스킴 없이 저장된 북마크도 제 줄을 지킨다.
  - 점 없는 호스트(`devbox:3000`)는 스킴으로 읽힌다 — `http://devbox:3000`처럼 스킴을 쓴다.
- URL 토큰이 없는 새 탭 줄은 단일 토큰이 `host[:port][/path]` 꼴이면 URL로 읽는다(`localhost` `127.0.0.1:8080/x` `example.com`). 북마크 줄에는 쓰지 않는다.
- 그룹 폴더: 이름 끝이 ` [color]`(grey blue red yellow green pink purple cyan orange)면 색이다. 제목이 빈 그룹은 `[blue]/`.
- 빈 줄은 무시한다. 렌더는 최상위 블록 사이에 빈 줄 하나를 둔다.
- 부모 = **앞쪽에서 가장 가까운, 들여쓰기가 더 작은 folder 줄**(entry 줄은 부모가 못 된다).

### 렌더 예

```
/w1 Window 1/
  /t11 Neovim https://neovim.io/
  /t12 oil.nvim https://github.com/stevearc/oil.nvim
  /g5 Research [blue]/
    /t13 Attention https://arxiv.org/abs/1706.03762
    /t14 GPT-3 https://arxiv.org/abs/2005.14165
  /t15 Hacker News https://news.ycombinator.com/

/w2 Window 2/
  /t21 tmux-oil https://github.com/minhyeoky/tmux-oil.nvim
  /t22 CodeMirror https://codemirror.net/

/b1 Bookmarks bar/
  /b10 Dev/
    /b11 GitHub https://github.com/
    /b12 MDN https://developer.mozilla.org/
  /b13 Read later/

/b2 Other bookmarks/
  /b20 Wikipedia https://www.wikipedia.org/

/b3 Mobile bookmarks/
```

화면에는 앵커가 안 보이고, 그 자리에 favicon(`_favicon/?pageUrl=`)이 그려진다. URL 토큰은 흐리게, 폴더 줄은 종류별 색으로 칠한다. 창 줄 뒤 virtual text로 `· 6 tabs · focused`, 핀 탭·활성 탭은 virtual 표식.

### 정규화 (render ∘ parse 항등성)

- 제목: 공백류(개행·탭 포함) 연속을 공백 하나로, 앞뒤 trim.
- URL: 공백을 `%20`으로. 탭 URL이 비면 `pendingUrl`, 그래도 비면 `about:blank`.
- base 비교는 raw API 값이 아니라 **정규화한 값**과 한다 — 손대지 않은 버퍼의 plan은 항상 비어야 한다.

## 3. 위치가 역할을 정한다

| 위치 | entry | folder |
|---|---|---|
| 최상위(부모 없음) | 오류 | 창 — 단, `/b<root id>` 앵커면 북마크 루트 |
| 창 아래 | 탭 | 탭 그룹 |
| 그룹 아래 | 탭 | 오류(그룹은 중첩 불가) |
| 북마크 루트·폴더 아래 | 북마크 | 북마크 폴더 |

- 도메인은 최상위 조상이 정한다 — 창 아래면 tabs, 북마크 루트 아래면 bookmarks.
- 창 이름 텍스트는 무시한다(창 이름 API가 없다). 북마크 루트 이름도 무시한다.
- 그룹 멤버는 그룹 줄 자리에 연속으로 놓인다 — 그룹 줄과 멤버 사이에 내어쓴 탭이 끼면, 그 탭은 그룹 블록 뒤로 간다.

## 4. 앵커 → 정체성

앵커 kind와 위치 역할이 맞으면 **정체 후보**다(t↔탭, w↔창, g↔그룹, b폴더↔북마크 폴더, b북마크↔북마크, b루트↔최상위 루트).

- 한 엔티티의 정체 후보가 여럿이면 원본을 이 순서로 고른다. 나머지는 복사본이다.
  1. 부모 줄이 base 부모의 원본인 첫 후보
  2. 부모 줄의 앵커가 base 부모와 같은 첫 후보
  3. 문서 순서 첫 후보
  - 복사한 블록을 다른 데 붙여도 원본은 제자리에 남는다.
- 역할이 안 맞는 앵커(예: 탭 줄이 북마크 폴더 아래)는 **그 위치 역할의 새 엔티티**를 만든다. 값은 줄 텍스트에서, 비면 원래 엔티티에서 가져온다.
  - 탭 → 북마크 폴더: 북마크 생성. 그 탭에 tabs 도메인 정체 후보가 없으면 탭은 닫힌다(= 저장하고 닫기).
  - 북마크 → 창 아래: 탭 열기. 북마크에 정체 후보가 없으면 북마크는 지워진다.
  - 북마크 폴더 블록 → 최상위: 새 창(자식 북마크는 탭으로). 창 블록 → 북마크 루트 아래: 새 폴더(자식 탭은 북마크로).
  - 그룹 줄 → 북마크 폴더 아래: 새 폴더(자식 탭은 북마크로). 제목에서 ` [color]`를 뗀다 — 색은 그룹 문법이다. `g` 앵커가 아닌 폴더 줄(손으로 쓴 줄, 창 줄)은 이름 그대로 둔다.
- 정체 후보가 0개인 base 엔티티는 제거다 — 탭 닫기, 북마크 삭제, 폴더는 removeTree, 그룹은 해제(멤버는 각자 자기 줄을 따른다), 창은 별도 동작 없음(탭이 다 빠지면 크롬이 닫는다).
- base에 없는 앵커(이전 렌더에서 yank해 둔 줄 등)는 앵커 없는 새 줄로 다룬다 — 닫은 탭 줄을 `p`하면 다시 열린다.
- 앵커가 있고 내용이 빈 줄은 "값 유지"다(탭은 URL 유지, 북마크 제목은 빈 문자열이 된다 — 보이는 대로).

## 5. plan(base S, fresh F, text)

`:w`는 fresh snapshot F를 새로 읽어 plan을 계산한다. 미리보기 마크는 F=S로 같은 함수를 부른다.

- **내용 변경은 S 기준**이다 — 줄의 URL이 S와 같으면, F에서 바뀌었어도 건드리지 않는다(밖에서 navigate한 걸 되돌리지 않는다).
- **위치 변경은 F 기준**이다 — 지금 실제 위치와 desired를 비교한다.
- F에만 있는 엔티티(편집 중 밖에서 생긴 것)는 버퍼에 없으니 절대 닫지 않는다.
- S에 있고 F에 없는 엔티티(밖에서 닫힘):
  - 제거 대상이면 조용히 건너뛴다.
  - 그 줄이 남아 있으면 경고 `gone — skipped`로 건너뛴다(되살리지 않는다).
  - 다른 줄의 desired 부모가 사라졌으면 **오류**로 막는다 — `:e!`로 다시 읽으라고 한다.
- 오류가 하나라도 있으면 적용을 거부한다.

### 액션 종류

| kind | 확인창 표기 | 실행 |
|---|---|---|
| new-window | `+ window` | `windows.create({tabId|url, focused:false})` |
| new-tab | `+ tab <url> → <창>` | `tabs.create({windowId, url, active:false})` |
| new-group | `+ group <title> [color]` | `tabs.group({tabIds, createProperties})` + `tabGroups.update` |
| new-bookmark / new-folder | `+ bookmark` / `+ folder` | `bookmarks.create` |
| (위 new-*에 source가 다른 도메인이면) | `★ bookmark (from tab)` / `↗ tab (from bookmark)` | 같은 create |
| move-tab | `→ tab <title> → <창>[/<그룹>]` | ungroup → `tabs.move` → `tabs.group` |
| move-group | `→ group <title> → <창>` | `tabGroups.move` |
| move-bookmark / move-folder | `→ <title> → <경로>` | `bookmarks.move` |
| reorder | `↕ <부모> (n)` | 부모 단위 한 줄 |
| navigate-tab | `↻ tab <old> → <new url>` | `tabs.update({url})` |
| edit-bookmark / edit-folder / edit-group | `✎ ...` | `bookmarks.update` / `tabGroups.update` |
| close-tab | `✕ tab <title>` | `tabs.remove` |
| delete-bookmark / delete-folder | `✕ bookmark` / `✕ folder <title> (n bookmarks)` | `remove` / `removeTree` (가장 바깥 폴더만, 하위는 한 줄로 합친다 — n은 함께 지워지는 북마크) |
| remove-group | `✕ group <title> (ungroup)` | 표시 전용 — 멤버 이동이 실행을 진다 |

경고(적용은 함): 탭 제목 수정(`title is read-only`), 핀 탭을 비핀 뒤로 보냄(`pinned tabs stay first`), 그룹 안의 핀 탭(`pinned tabs can't be grouped` — 그룹 밖에 둔다), 사라진 엔티티 줄.

오류(적용 거부): 최상위 entry, 그룹 안 폴더, 북마크 루트 삭제·이동, URL 없는 새 북마크, URL로 못 읽는 새 탭 줄(단일 토큰 `host[:port][/path]`는 URL로 읽는다 — §2), 사라진 부모.

## 6. 실행 순서 — 만들기 → 배치 → 갱신 → 지우기

desired 구조(창별 탭 순서·그룹 멤버십, 폴더별 자식 순서)를 F에 맞춰 reconcile한다. 인덱스 산수 대신 "원하는 배치가 될 때까지 옮기고 검증"한다.

1. **만들기**
   - 먼저 창이 비어 닫히지 않게 한다. 크롬은 마지막 탭이 떠난 창을 닫고, 그러면 그 창을 쓰는 뒤 단계(새 탭 만들기·탭 옮겨 오기)가 "No window with id"로 실패한다.
   - 기존 창의 탭이 전부 떠나면 그 창에 `about:blank` placeholder 탭(`active:false`)을 붙인다. 탭이 떠나는 경우는 둘이다 — desired가 그 탭을 다른 창에 둔다(새 창의 첫 탭 포함). 또는 그 탭이 든 그룹이 다른 창으로 간다(`tabGroups.move`는 닫을 탭·plan이 모르는 탭까지 그룹의 탭을 전부 데려간다).
   - 떠나지 않는 탭이 하나라도 있는 창에는 붙이지 않는다. 그룹이 가지 않는 닫을 탭(지우기 단계까지 제자리)과 밖에서 열린 탭(옮기지 않음)이 그런 탭이다. 버퍼가 일부러 비운 창에도 붙이지 않는다 — 크롬이 닫도록 둔다(§4).
   - placeholder는 맨 끝에 붙어 그룹 밖에 있고 옮기지 않는다. 배치 1–7이 끝나면 지운다. 지우기 실패는 무시하고, 성공 수·불일치 보고에 세지 않는다.
   - 새 창: 첫 자식이 기존 탭이면 `windows.create({tabId})`로 옮기며 만든다. 아니면 첫 새 탭 URL로 만든다. 자식이 없으면 경고하고 건너뛴다.
   - 새 탭(복사·다른 도메인 포함)은 `tabs.create({active:false})` — `duplicate`는 활성 탭을 뺏어서 안 쓴다.
   - 북마크·폴더는 위에서 아래로 만든다.
2. **배치** — 크롬 동작은 e2e로 관측했다(`test/e2e/chrome-behavior.test.mjs`).
   1. 창이 바뀐 기존 그룹 → `tabGroups.move(..., {index:-1})`.
   2. 닫을 탭은 그룹에서 먼저 뺀다 — 그룹 안쪽 자리로 옮긴 탭은 그 그룹에 들어가기 때문이다.
   3. 창별로 다른 창의 탭을 끝으로 데려온다. 창을 건너면 그룹과 핀이 풀리므로 핀은 다시 건다.
   4. 그룹이 바뀌는 탭 중 지금 그룹에 든 것 → `tabs.ungroup`.
   5. 알려진 탭의 상대 순서가 이미 맞으면 건너뛴다. 아니면 항목(탭·그룹) 단위로 `tabs.move`·`tabGroups.move`로 놓는다. index는 최종 위치로 정확히 떨어진다. 모르는 탭은 뒤로 밀린다. 핀 탭은 0부터 놓고 안 핀 항목은 지금 창의 핀 탭 수 바로 뒤부터 놓는다 — 크롬은 안 핀 탭을 모든 핀 탭 뒤에 두므로, desired에 없는 핀 탭(닫을 탭·밖에서 핀한 탭)은 desired 핀 탭 뒤에 남는다.
   6. 그룹 멤버십: 기존 그룹은 `tabs.group({groupId})`, 새 그룹은 `tabs.group({createProperties:{windowId}})` 뒤 `tabGroups.update`. 멤버가 다 빠져 사라진 그룹은 제목·색으로 다시 만든다.
   7. 순서를 한 번 더 맞추고 검증한다. 불일치가 남으면 최대 4회까지 되풀이하고, 그래도 남으면 결과 경고로 보고한다.
   8. 북마크: 폴더별로 i 오름차순 `bookmarks.move(child, {parentId, index:i})`. 같은 부모 안에서 높은 인덱스로 옮기면 한 칸 앞에 떨어지므로, 항상 낮은 인덱스로만 옮긴다. 그 뒤 검증한다. 그 사이 밖에서 지워진 폴더는 오류로 보고한다 — 지우기 단계는 건너뛴다.
3. **갱신**: navigate, 북마크 제목·URL, 그룹 제목·색.
4. **지우기**: 1–3에서 오류가 하나라도 났으면 **통째로 건너뛴다**(옮겨 담기 실패 후 원본이 지워지는 손실을 막는다).
   - 지우기 직전, 지울 북마크 하위 트리와 닫을 탭(URL·제목)을 `chrome.storage.local` journal에 남긴다(최근 20회). 탭은 그때 다시 읽은 지금의 URL·제목이고, 읽지 못하면 plan 값이다.
   - 지우기를 건너뛰면 닫으려고 미리 그룹에서 뺀 탭(배치 2)을 `tabs.group({tabIds, groupId})`로 원래 그룹에 되돌린다. 그룹이 아직 있을 때만 하고(마지막 멤버가 떠나면 그룹은 사라진다), 배치 중 다시 만든 그룹이면 새 id로 찾는다. 탭은 원래 index가 아니라 그룹 가장자리에 붙는다. 이미 닫힌 탭은 빼고 보내며(`tabs.group`은 모르는 id가 하나라도 있으면 통째로 거부한다) 실패는 오류로 보고한다.
   - `removeTree` 직전 하위 트리를 다시 읽는다. plan이 못 본 북마크가 들어 있으면 그 폴더 삭제를 거부한다.
5. **보고**: 성공 수·오류·경고·검증 불일치를 돌려주고, 편집기는 live 상태로 다시 렌더한다(undo 히스토리 초기화, vim 레지스터·접기 상태는 유지).

## 7. 편집기

- 창: popup 타입, 960×720, 마지막으로 포커스된 일반 창 가운데. 목록은 `type: 'normal'` 창만이고, 편집기 자신의 URL도 이중으로 뺀다. 이미 열려 있으면 그 창에 포커스.
- 열 때 커서는 마지막 포커스 창의 활성 탭 줄.
- **앵커 보호**(transactionFilter): 줄바꿈까지 지우는 줄 삭제(`dd`)만 앵커를 지울 수 있다. 그 외 삭제가 앵커에 걸치면 앵커를 빼고 지운다. 앵커 안·앞(공백이 아닌 텍스트)에 들어가는 삽입은 앵커 뒤로 옮긴다. 앵커 앞 공백 삽입(`>>`)은 허용.
  - 결과: `cc` `S` `C` `D` `x` 는 정체를 유지한 채 내용만 바꾼다. `dd`만 삭제다.
  - 줄 단위 변경은 `cc`와 같다 — `Vc` `Vs` `VC` `VS` `VR` `vC` `vR` `vS` `<C-v>R` `<C-v>S`와 여러 줄 `c{모션}`(`cj` `ck` `cip`). 한 줄이면 앵커를 유지한 채 내용만 바뀐다. 여러 줄이면 첫 줄이 그렇고 나머지 줄은 `dd`처럼 지워져 한 줄이 된다. 첫 줄이 들여쓰기 0인 창·북마크 루트 줄이어도 같다. 줄 안의 `c{모션}`, 문자 비주얼 `c`, 블록 비주얼 `c` `C` `s`는 그대로다.
  - 앵커 줄을 앞줄에 붙이는 `J`는 막는다. 같은 길이 치환(`r` `~` `gu` `:s`)은 내용에만 먹는다. 앵커 안의 글자를 바꾸는 편집은 거부한다.
  - 내용이 있는 줄의 앵커 끝(첫 글자 앞)에 들어오는 줄바꿈(insert 모드 `<CR>`)은 줄 시작으로 옮긴다. 앵커와 내용이 함께 내려가고 위에 빈 줄이 남으며, 자동 들여쓰기는 붙이지 않는다. 커서는 내려간 줄의 내용 시작에 선다. 내용 중간·줄 끝·내용이 없는 앵커 줄의 줄바꿈은 손대지 않는다.
- **커서 제약**: 앵커 줄의 빈 커서가 [줄 시작, 앵커 끝)에 오면 앵커 끝으로 보낸다 — `0` `^` `I`가 이름 시작으로 간다.
- **미리보기 마크**: 문서가 바뀔 때마다 plan(S, S, text)를 계산해 줄 끝에 마크를 단다 — `+ new` `⧉ copy` `→ Window 2` `→ [Research]` `↻ navigate` `✎ edit` `★ bookmark` `↗ open` `⚠ …` `✗ …`. insert 모드는 40ms 디바운스, normal 모드는 즉시. 지워진 것은 줄이 없으니 상태줄 집계(`+2 →3 ✎1 ✕4`)로 보인다.
- **키** (tmux-oil과 맞춘다)

| 키 | 동작 |
|---|---|
| `:w` | 확인창 → 적용 (`:wq` `:x`는 적용 후 닫기) |
| `:q` / `q` | 닫기(수정이 있으면 거부, `:q!`로 강제) |
| `:e!` / `R` | 다시 읽기(수정 버림) |
| `<CR>` | 탭 줄: 그 탭·창으로 이동하고 편집기 닫기 / 그룹 줄: 첫 탭으로 / 북마크 줄: 새 탭으로 열기 / 폴더 줄: 접기 토글 / 수정 중이면 이동만 하고 안 닫는다 |
| `za` `zc` `zo` `zR` `zM` | 폴더 접기 (codemirror-vim에 없어서 직접 묶었다) |
| `Tab` / `S-Tab` | 들여쓰기 / 내어쓰기 |
| `g?` | 도움말 |

- **확인창**: `y` `Y` `o` `O` `<CR>` 적용, `n` `N` `q` `<Esc>` 취소. 액션을 종류별로 묶어 보여주고 삭제 수를 맨 위에 빨갛게 — 닫는 탭, 지우는 북마크, 지우는 폴더(하위 폴더 포함)를 하나씩 센다.
- **라이브 갱신**: tabs·windows·tabGroups·bookmarks 이벤트가 오면, 버퍼가 마지막 렌더와 같을 때만 다시 렌더한다(150ms 디바운스, 커서는 같은 앵커 줄로). 수정 중이면 상태줄에 `⟳ chrome changed — :e! to reload`.
- **접기 상태**: 다시 렌더할 때(라이브 갱신·`:w`·`:e!`)마다 접힌 폴더 줄을 앵커로 기억했다가, 새 버퍼에서 같은 앵커의 폴더 줄을 다시 접는다. 폴더 줄이 아니게 됐거나 자식이 없으면 건너뛴다. 커서가 들어간 블록은 접지 않는다.
- 테마: gruvbox dark, `JetBrainsMono Nerd Font, JetBrains Mono, ui-monospace, Menlo`.

## 8. 파일

```
manifest.json            permissions: tabs tabGroups bookmarks storage favicon
src/background.js        action·command → openEditor(); globalThis.oilOpenEditor (테스트용)
src/editor.html|css
src/editor/main.js       CodeMirror·vim 설정, ex 명령, 키 매핑, 라이브 갱신
src/editor/anchors.js    conceal·atomic·보호 필터·커서 제약
src/editor/marks.js      문법 강조, 미리보기 마크, 상태줄
src/editor/confirm.js    확인창, 도움말
src/core/grammar.js      parseLine, 상수
src/core/render.js       snapshot → { text, lines }
src/core/parse.js        text → tree
src/core/plan.js         (S, F, text) → { actions, desired, errors, warnings, marks }
src/core/snapshot.js     chrome API → 정규화 snapshot
src/core/apply.js        plan + api → reconcile 실행, 결과·검증
test/unit/               node --test (core 전부)
test/e2e/                Playwright, 확장 로드한 Chromium (headless new)
scripts/build.mjs        esbuild → dist/
scripts/demo.mjs         headed 데모: 시드 + 편집기 열기
scripts/record.mjs       스크립트 데모 → demo/demo.gif
```

## 9. 검증 기준

**unit (plan 골든 케이스)** — §2 렌더 예를 S로 둔다.

| # | 편집 | 기대 |
|---|---|---|
| G1 | 없음 | 액션·오류 0 |
| G2 | t15 줄 삭제 | close-tab t15 |
| G3 | t12 줄을 t22 뒤로 | move-tab t12 → w2, w2 순서 [t21 t22 t12] |
| G4 | t21↔t22 | reorder w2만, move-tab 없음 |
| G5 | t12 줄 복사해 w2에 붙임 | new-tab(oil.nvim URL, w2), t12 그대로 |
| G6 | w2 아래 `https://example.com/` / `example.com` / `hello world` | new-tab ×2 / 세 번째는 오류 |
| G7 | 최상위 `new/` 아래 t12 줄 + `https://a.test/` | new-window, move-tab t12, new-tab a.test |
| G8 | t13을 들여쓰기 2로 | move-tab t13 → w1(ungroup), w1 순서 [t11 t12 (g5: t14) t13 t15] |
| G9 | t15를 t14 뒤 들여쓰기 4로 | move-tab t15 → [Research] |
| G10 | w1 아래 `Later [green]/` + 그 아래 t15 | new-group Later green {t15} |
| G11 | g5를 `Papers [red]/`로 | edit-group 제목·색 |
| G12 | g5 줄만 삭제 | t13·t14 ungroup(move-tab), remove-group g5 |
| G13 | t12 URL 수정 | navigate-tab t12 |
| G14 | t12 제목 수정 | 액션 0, 경고 |
| G15 | b12 삭제 / b10 블록 삭제 | delete-bookmark b12 / delete-folder b10 (2) 한 줄 |
| G16 | b10 줄만 삭제 | move-bookmark b11·b12 → Bookmarks bar, delete-folder b10 (0) |
| G17 | b11 제목 수정 | edit-bookmark |
| G18 | b20을 Read later 아래로 | move-bookmark b20 |
| G19 | t15 줄을 Read later 아래로 이동 | new-bookmark(from t15) + close-tab t15, 순서는 생성 먼저 |
| G20 | t12 줄을 Read later 아래로 복사 | new-bookmark(from t12)만 |
| G21 | b11 줄을 w2 아래로 이동 | new-tab(from b11) + delete-bookmark b11 |
| G22 | b10 블록을 복사해 최상위에 | new-window + new-tab ×2, 원본 유지 |
| G23 | w2 블록을 Bookmarks bar 아래 들여써 복사 | new-folder "Window 2" + new-bookmark ×2, w2 유지 |
| G24 | 최상위 entry / 그룹 안 폴더 / b2 줄 삭제 / URL 없는 새 북마크 | 각각 오류, 적용 거부 |
| G25 | w2 아래 `/t99 Foo https://foo.test/` (S에 없음) | new-tab foo.test + 경고 |
| G26 | 버퍼 그대로, F에 t30 추가·t22 사라짐 | 액션 0(t30 안 닫음), t22 줄은 경고 |
| G27 | 핀 탭 t11을 t12 뒤로 | 경고, 핀 탭은 앞 유지 |
| G28 | 복잡한 S에서 render→parse→plan | 액션 0 (항등성) |

**e2e (실 Chromium)** — G2–G23의 대표 케이스를 실제로 적용해 최종 크롬 상태를 단언하고, 적용 직후 다시 렌더한 plan이 비는지(E-idem)까지 본다. 편집기 키 입력(`dd` `p` `>>` `cc` `:w` `y` `R` `<CR>`)도 실제 키로 친다.

## 10. 남는 위험·미결

- 북마크 삭제는 sync로 모든 기기에 퍼지고 크롬엔 undo API가 없다 — journal만 남긴다. 복원 명령은 다음 단계.
- 저장된 탭 그룹: API로 그룹을 풀거나 마지막 탭을 닫으면 저장본까지 지워지고, 그 삭제가 sync된다는 보고가 있다(단일 출처, Chrome 148). 그룹 줄 삭제(G12)가 이 경로를 탄다.
- 계정/로컬 북마크 분리(Chrome 134+ `folderType`·`syncing`)로 루트에 "Bookmarks bar"가 둘 뜰 수 있다. 지금 렌더는 이름만 보여서 둘이 구분되지 않는다.
- 브랜드 Chrome은 `--load-extension`(137+)·`--disable-extensions-except`(139+)를 무시한다. 데모·테스트는 Chrome for Testing(Playwright)으로 하고, 평소 쓰는 Chrome에는 `chrome://extensions` → 압축해제 로드로만 들어간다.
- Chrome for Testing 156은 아래 순서 뒤 창을 닫으면 죽는다(SIGSEGV). oil.chrome 코드 없이 `chrome.*` 호출만으로 재현되고, 브랜드 Chrome에서는 확인하지 않았다.
  - 활성 탭을 품은 그룹을 다른 창으로 옮긴다(`tabGroups.move`).
  - 그 창에서 원래 활성이던 탭을 그룹이 떠난 창으로 옮긴다.
  - 그룹이 간 창을 먼저 닫는다 — 반대 순서로 닫으면 살아남는다.
- placeholder 탭을 지울 때마다 "최근 닫은 탭"에 `about:blank` 항목이 남아 Cmd+Shift+T가 그것부터 연다(Chrome for Testing 156에서 `chrome.sessions.getRecentlyClosed`로 확인).
- 창 이름 API는 없다. 창 이름, 탭 제목 수정, 탭 음소거·핀 토글, 읽기 목록·최근 닫은 탭 뷰는 범위 밖.

### 알려진 결함 (프로토타입, 미수정)

- 편집 중 바깥에서, 지울 폴더 밖으로 옮긴 북마크는 지워지지 않고 남는다 — 무엇을 지울지는 S의 트리로 정하고 `removeTree`는 지금 트리에 건다.
- 폴더·창·그룹 줄에서 `cc` 후 비우면 빈 entry로 읽혀 쓰기가 거부된다(손실은 없음).
- 블록 비주얼 `c` `C`는 한 줄에만 먹는다. `<C-v>jc` 뒤 `X`는 GitHub/MDN을 `XGitHub`/`DN`으로 만든다(`XitHub`/`XDN`이어야 한다). 블록 선택이 범위 하나로 합쳐지기 때문이다(`allowMultipleSelections`가 꺼져 있다).
- 문자 비주얼로 고른 여러 줄의 끝이 다음 줄의 앵커 안이면, 복사·삭제·변경한 레지스터에 앵커 조각이 담긴다. 줄 맨 앞에 붙이면 엉뚱한 앵커 토큰이 생길 수 있다.
