#!/bin/sh
# Keep the marker and ownership rules interoperable with src/skill/skill-installer.ts.
set -eu
LC_ALL=C
export LC_ALL

# The public endpoint replaces this assignment with PUBLIC_URL, shell-quoted.
engine_url=''

fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' \
    'Usage: sh skills/install.sh [<install|update|status> <claude-code|codex|hermes|cline|kiro|qwen-code> [--project dir] [--force]]' \
    'Without arguments, choose the client and scope interactively using /dev/tty.' \
    'Non-interactive examples (also work without a terminal):' \
    '  curl -fsSL <ENGINE_URL>/skills/install.sh | sh -s -- install claude-code' \
    '  sh skills/install.sh install codex --project /path/to/project' >&2
  exit 1
}
trap 'exit 1' HUP INT TERM
prompt() {
  printf '%s' "$1" >&2
  IFS= read -r answer < /dev/tty || fail 'Aborted: no answer read; no skill files were changed.'
}
action=auto
client=''
if [ "$#" -gt 0 ]; then
  case $1 in install|update|status) action=$1; shift ;; *) usage ;; esac
fi
if [ "$#" -gt 0 ]; then
  case $1 in --*) ;; *) client=$1; shift ;; esac
fi
force=false
project_set=false
project_missing=false
base=${HOME-}
while [ "$#" -gt 0 ]; do
  case $1 in
    --project)
      if [ "$#" -ge 2 ]; then base=$2; shift 2
      else project_missing=true; shift; fi
      project_set=true
      ;;
    --force) force=true; shift ;;
    *) usage ;;
  esac
done
interactive=false
if [ -z "$client" ] || [ "$project_missing" = true ]; then
  # Opening /dev/tty fails immediately when there is no controlling terminal.
  ( [ -t 0 ] < /dev/tty ) 2>/dev/null || usage
  interactive=true
fi
if [ -z "$client" ]; then
  # Local status is cheap; remote status would download every complete bundle.
  case $0 in */*) preview_assets=${0%/*} ;; *) preview_assets=. ;; esac
  if [ -f "$0" ] && [ -f "$preview_assets/llmwiki/SKILL.md" ]; then
    printf '%s\n' 'Existing installations (personal unless --project was supplied):' >&2
    for preview_client in claude-code codex hermes cline kiro qwen-code; do
      if [ "$project_set" = true ] && [ "$project_missing" = false ]; then
        preview_status=$(sh "$0" status "$preview_client" --project "$base" 2>/dev/null | awk '/"state":/ { gsub(/[",]/, "", $2); print $2 }')
      else
        preview_status=$(sh "$0" status "$preview_client" 2>/dev/null | awk '/"state":/ { gsub(/[",]/, "", $2); print $2 }')
      fi
      printf '  %s: %s\n' "$preview_client" "${preview_status:-unavailable}" >&2
    done
  fi
  printf '%s\n' 'Choose a client:' '  1) Claude Code (default)' '  2) Codex · Gemini CLI · OpenCode · Cursor · GitHub Copilot (VS Code/CLI) · Windsurf/Devin Desktop · Roo Code · Amp · Goose · Factory Droid · Zed · Crush (~/.agents/skills)' '  3) Hermes' '  4) Cline' '  5) Kiro' '  6) Qwen Code' >&2
  while :; do
    prompt 'Client [1]: '
    case $answer in
      ''|1|claude-code) client=claude-code; break ;;
      2|codex) client=codex; break ;;
      3|hermes) client=hermes; break ;;
      4|cline) client=cline; break ;;
      5|kiro) client=kiro; break ;;
      6|qwen-code) client=qwen-code; break ;;
      *) printf '%s\n' 'Choose a listed client.' >&2 ;;
    esac
  done
fi
case $client in
  claude-code) client_root=.claude ;;
  codex) client_root=.agents ;;
  hermes) client_root=.hermes ;;
  cline) client_root=.cline ;;
  kiro) client_root=.kiro ;;
  qwen-code) client_root=.qwen ;;
  *) usage ;;
esac
if [ "$interactive" = true ] && [ "$project_set" = false ]; then
  while :; do
    prompt 'Scope: 1) personal (default) 2) project [1]: '
    case $answer in
      ''|1|personal) break ;;
      2|project) project_set=true; project_missing=true; break ;;
      *) printf '%s\n' 'Choose 1 or 2.' >&2 ;;
    esac
  done
fi
if [ "$project_missing" = true ]; then
  if [ "$client" = hermes ]; then printf '%s\n' 'Hermes projects must be a git root (containing .git).' >&2; fi
  while :; do
    prompt 'Project directory [current directory]: '
    base=${answer:-.}
    if [ -d "$base" ] && { [ "$client" != hermes ] || [ -e "$base/.git" ]; }; then break; fi
    printf '%s\n' 'Choose an existing directory (a git root for Hermes).' >&2
  done
fi
[ "$project_set" = true ] || [ -n "$base" ] || fail 'HOME is not set; use --project dir.'
current_directory=$(pwd -P; printf '.')
current_directory=${current_directory%.}
current_directory=${current_directory%?}
[ -n "$base" ] || base=.
# Lexical resolution is intentional: cd/realpath would hide symlink ancestors.
absolute_path() {
  case $1 in /*) absolute_input=$1 ;; *) absolute_input=$current_directory/$1 ;; esac
  LLMWIKI_PATH=$absolute_input awk 'BEGIN {
    count = split(ENVIRON["LLMWIKI_PATH"], parts, "/"); depth = 0;
    for (i = 1; i <= count; i++) {
      if (parts[i] == "" || parts[i] == ".") continue;
      if (parts[i] == "..") { if (depth) depth--; }
      else stack[++depth] = parts[i];
    }
    if (!depth) printf "/";
    for (i = 1; i <= depth; i++) printf "/%s", stack[i];
  }'
}
case $0 in */*) script_directory=${0%/*}; [ -n "$script_directory" ] || script_directory=/ ;; *) script_directory=. ;; esac
assets=$(absolute_path "$script_directory"; printf '.')
assets=${assets%.}
directory=$(absolute_path "$base/$client_root/skills/llmwiki")
marker_name=.llmwiki-install.json
marker_path=$directory/$marker_name
if command -v sha256sum >/dev/null 2>&1; then
  hash_command=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  hash_command=shasum
else
  fail 'SHA-256 requires sha256sum or shasum -a 256.'
fi
hash_file() {
  if [ "$hash_command" = sha256sum ]; then
    digest=$(sha256sum < "$1") || fail "Cannot hash skill file: $1"
  else
    digest=$(shasum -a 256 < "$1") || fail "Cannot hash skill file: $1"
  fi
  file_hash=${digest%% *}
}
entry_exists() { [ -e "$1" ] || [ -L "$1" ]; }
safe_path() {
  safe_current=$1
  while :; do
    [ ! -L "$safe_current" ] || fail "Refusing symlink installation path: $safe_current"
    [ "$safe_current" != / ] || break
    safe_current=${safe_current%/*}
    [ -n "$safe_current" ] || safe_current=/
  done
}
preflight_file() {
  safe_path "$1"
  if entry_exists "$1" && [ ! -f "$1" ]; then fail "Refusing non-file skill destination: $1"; fi
  parent=${1%/*}
  while :; do
    if entry_exists "$parent" && [ ! -d "$parent" ]; then fail "Refusing non-directory skill parent: $parent"; fi
    [ "$parent" != / ] || break
    parent=${parent%/*}
    [ -n "$parent" ] || parent=/
  done
}

# mkdir is the portable, exclusive temporary-directory primitive (no mktemp required).
previous_umask=$(umask)
umask 077
attempt=0
while :; do
  temporary=${TMPDIR:-/tmp}/llmwiki-install.$$.$attempt
  if mkdir "$temporary" 2>/dev/null; then break; fi
  attempt=$((attempt + 1))
  [ "$attempt" -lt 10 ] || fail 'Cannot create a private installer temporary directory.'
done
umask "$previous_umask"
trap 'rm -rf "$temporary"' 0
trap 'exit 1' HUP INT TERM
mkdir "$temporary/bundle" "$temporary/old" "$temporary/modified" "$temporary/unmanaged"
printf '0' > "$temporary/bundle/count"
old_count=0
modified_count=0
unmanaged_count=0

# A complete JSON grammar, rather than line/regex extraction, also accepts markers
# emitted by JSON.stringify with escaped names, nested unknown fields and Unicode.
# Output is exclusively single-quoted shell assignments/calls after validation.
parse_json() {
  LLMWIKI_JSON_MODE=$1 LLMWIKI_CLIENT=$client awk '
  function bad() { exit 1 }
  function whitespace() { while (substr(text, position, 1) ~ /^[ \t\r\n]$/) position++ }
  function shell_quote(s,    result, i, c) {
    result = "\047";
    for (i = 1; i <= length(s); i++) {
      c = substr(s, i, 1);
      result = result (c == "\047" ? "\047\\\047\047" : c);
    }
    return result "\047";
  }
  function json_characters(s,    result, i, c, code) {
    result = "";
    for (i = 1; i <= length(s); i++) {
      c = substr(s, i, 1);
      if (c == "\"") result = result "\\\"";
      else if (c == "\\") result = result "\\\\";
      else if (c == "\b") result = result "\\b";
      else if (c == "\f") result = result "\\f";
      else if (c == "\n") result = result "\\n";
      else if (c == "\r") result = result "\\r";
      else if (c == "\t") result = result "\\t";
      else if (c == sprintf("%c", 0)) result = result "\\u0000";
      else if ((code = index(controls, c))) result = result sprintf("\\u%04x", code);
      else result = result c;
    }
    return result;
  }
  function hex4(at,    i, digit, result) {
    result = 0;
    for (i = at; i < at + 4; i++) {
      digit = index("0123456789abcdef", tolower(substr(text, i, 1))) - 1;
      if (digit < 0 || i > length(text)) bad();
      result = result * 16 + digit;
    }
    return result;
  }
  function utf8(code) {
    if (code < 128) return sprintf("%c", code);
    if (code < 2048) return sprintf("%c%c", 192 + int(code / 64), 128 + code % 64);
    if (code < 65536) return sprintf("%c%c%c", 224 + int(code / 4096), 128 + int(code / 64) % 64, 128 + code % 64);
    return sprintf("%c%c%c%c", 240 + int(code / 262144), 128 + int(code / 4096) % 64, 128 + int(code / 64) % 64, 128 + code % 64);
  }
  function string(    result, encoded, c, escape, code, low) {
    if (substr(text, position++, 1) != "\"") bad();
    result = encoded = "";
    while (position <= length(text)) {
      c = substr(text, position++, 1);
      if (c == "\"") { string_json = "\"" encoded "\""; return result }
      if (c == "\\") {
        escape = substr(text, position++, 1);
        if (escape == "\"" || escape == "\\" || escape == "/") c = escape;
        else if (escape == "b") c = "\b";
        else if (escape == "f") c = "\f";
        else if (escape == "n") c = "\n";
        else if (escape == "r") c = "\r";
        else if (escape == "t") c = "\t";
        else if (escape == "u") {
          code = hex4(position); position += 4;
          if (code >= 55296 && code <= 56319 && substr(text, position, 2) == "\\u") {
            low = hex4(position + 2);
            if (low >= 56320 && low <= 57343) { code = 65536 + (code - 55296) * 1024 + low - 56320; position += 6 }
          }
          if (code >= 55296 && code <= 57343) {
            result = result utf8(65533); encoded = encoded sprintf("\\u%04x", code); continue;
          }
          c = utf8(code);
        } else bad();
      } else if (index(controls, c) || c == sprintf("%c", 0)) bad();
      result = result c; encoded = encoded json_characters(c);
    }
    bad();
  }
  function value(    node, c, key, child, token) {
    whitespace(); node = ++nodes; c = substr(text, position, 1);
    if (c == "\"") {
      kind[node] = "string"; data[node] = string(); encoded[node] = string_json;
    } else if (c == "{" || c == "[") {
      kind[node] = c == "{" ? "object" : "array"; position++; whitespace();
      if (substr(text, position, 1) == (c == "{" ? "}" : "]")) { position++; return node }
      while (1) {
        if (c == "{") {
          whitespace(); key = string(); whitespace();
          if (substr(text, position++, 1) != ":") bad();
        } else key = counts[node] + 1;
        child = value();
        if (!((node SUBSEP key) in members)) keys[node, ++counts[node]] = key;
        members[node, key] = child;
        whitespace(); token = substr(text, position++, 1);
        if (token == (c == "{" ? "}" : "]")) break;
        if (token != ",") bad();
      }
    } else if (match(substr(text, position), /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/)) {
      kind[node] = "number"; data[node] = substr(text, position, RLENGTH); position += RLENGTH;
    } else if (substr(text, position, 4) == "true" || substr(text, position, 4) == "null") {
      kind[node] = substr(text, position, 4); position += 4;
    } else if (substr(text, position, 5) == "false") {
      kind[node] = "false"; position += 5;
    } else bad();
    return node;
  }
  function safe_name(name,    path, parts, count, i) {
    if (name == "" || name == ".llmwiki-install.json" || substr(name, 1, 1) == "/" || index(name, sprintf("%c", 0))) return 0;
    path = name; gsub(/\\/, "/", path); count = split(path, parts, "/");
    for (i = 1; i <= count; i++) if (parts[i] == "" || parts[i] == "." || parts[i] == "..") return 0;
    return 1;
  }
  BEGIN { for (i = 1; i < 32; i++) controls = controls sprintf("%c", i); position = 1 }
  { text = text $0 "\n" }
  END {
    root = value(); whitespace();
    if (position <= length(text) || kind[root] != "object") bad();
    version = members[root, "version"];
    if (kind[version] != "string" || length(data[version]) == 0) bad();
    if (ENVIRON["LLMWIKI_JSON_MODE"] == "version") {
      print "bundle_version_json=" shell_quote(encoded[version]); exit;
    }
    schema = members[root, "schema"]; client = members[root, "client"]; files = members[root, "files"];
    if (kind[schema] != "number" || data[schema] + 0 != 1 || kind[client] != "string" || data[client] != ENVIRON["LLMWIKI_CLIENT"] || kind[files] != "object") bad();
    for (i = 1; i <= counts[files]; i++) {
      name = keys[files, i]; child = members[files, name];
      if (!safe_name(name) || kind[child] != "string" || length(data[child]) != 64 || data[child] ~ /[^a-f0-9]/) bad();
    }
    if (ENVIRON["LLMWIKI_JSON_MODE"] == "remote") print "bundle_version_json=" shell_quote(encoded[version]);
    else print "installed_version_json=" shell_quote(encoded[version]);
    for (i = 1; i <= counts[files]; i++) {
      name = keys[files, i];
      print (ENVIRON["LLMWIKI_JSON_MODE"] == "remote" ? "add_remote " : "add_old ") shell_quote(name) " " shell_quote(data[members[files, name]]);
    }
  }' "$2"
}

# Records use numeric directories, not newline/tab-separated filenames. Appending
# a sentinel to reads preserves filenames ending in newlines in POSIX shell.
read_value() { value=$(cat "$1"; printf '.'); value=${value%.}; }
find_record() {
  lookup_directory=$1
  lookup_name=$2
  if [ "$lookup_directory" = "$temporary/old" ]; then lookup_count=$old_count
  else lookup_count=$(cat "$lookup_directory/count"); fi
  found_index=0
  lookup_index=1
  while [ "$lookup_index" -le "$lookup_count" ]; do
    read_value "$lookup_directory/$lookup_index/name"
    if [ "$value" = "$lookup_name" ]; then found_index=$lookup_index; break; fi
    lookup_index=$((lookup_index + 1))
  done
}
add_old() {
  old_count=$((old_count + 1))
  mkdir "$temporary/old/$old_count"
  printf '%s' "$1" > "$temporary/old/$old_count/name"
  printf '%s' "$2" > "$temporary/old/$old_count/hash"
}
add_bundle() {
  bundle_name=$1
  bundle_source=$2
  find_record "$temporary/bundle" "$bundle_name"
  if [ "$found_index" -eq 0 ]; then
    bundle_index=$(cat "$temporary/bundle/count")
    bundle_index=$((bundle_index + 1))
    mkdir "$temporary/bundle/$bundle_index"
    printf '%s' "$bundle_index" > "$temporary/bundle/count"
  else bundle_index=$found_index; fi
  printf '%s' "$bundle_name" > "$temporary/bundle/$bundle_index/name"
  cat "$bundle_source" > "$temporary/bundle/$bundle_index/content"
  hash_file "$temporary/bundle/$bundle_index/content"
  printf '%s' "$file_hash" > "$temporary/bundle/$bundle_index/hash"
}
load_files() (
  source_directory=$1
  prefix=$2
  [ -d "$source_directory" ] || fail "Skill asset directory is missing: $source_directory"
  for source_path in "$source_directory"/.[!.]* "$source_directory"/..?* "$source_directory"/*; do
    entry_exists "$source_path" || continue
    source_name=${source_path##*/}
    if [ -n "$prefix" ]; then source_name=$prefix/$source_name; fi
    if [ -L "$source_path" ]; then fail "Skill assets must be regular files: $source_path"
    elif [ -d "$source_path" ]; then load_files "$source_path" "$source_name"
    elif [ -f "$source_path" ]; then add_bundle "$source_name" "$source_path"
    else fail "Skill assets must be regular files: $source_path"; fi
  done
)
download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2" || fail "Cannot download skill asset: $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || fail "Cannot download skill asset: $1"
  else
    fail 'Remote installation requires curl or wget.'
  fi
}
add_remote() {
  remote_name=$1
  remote_hash=$2
  download "$engine_url/skills/files/$remote_hash" "$temporary/download"
  hash_file "$temporary/download"
  [ "$file_hash" = "$remote_hash" ] || fail "SHA-256 mismatch for skill asset: $remote_name"
  add_bundle "$remote_name" "$temporary/download"
}
if [ -f "$0" ] && [ -f "$assets/llmwiki/SKILL.md" ]; then
  assignments=$(parse_json version "$assets/version.json") || fail 'Invalid skill bundle version.json.'
  eval "$assignments"
  load_files "$assets/llmwiki" ''
else
  engine_url=${LLMWIKI_URL:-$engine_url}
  while [ "${engine_url%/}" != "$engine_url" ]; do engine_url=${engine_url%/}; done
  case $engine_url in http://?*|https://?*) ;; *) fail 'Remote installation requires an engine URL; set LLMWIKI_URL.' ;; esac
  download "$engine_url/skills/manifest/$client" "$temporary/manifest.json"
  assignments=$(parse_json remote "$temporary/manifest.json") || fail 'Invalid remote skill manifest.'
  eval "$assignments"
fi
find_record "$temporary/bundle" SKILL.md
[ "$found_index" -ne 0 ] || fail 'Canonical skill asset SKILL.md is missing'
bundle_count=$(cat "$temporary/bundle/count")

safe_path "$directory"
marker_valid=false
installed_version_json=null
if [ -f "$marker_path" ] && [ ! -L "$marker_path" ]; then
  if assignments=$(parse_json marker "$marker_path"); then
    eval "$assignments"
    marker_valid=true
  fi
fi
index=1
while [ "$index" -le "$old_count" ]; do
  read_value "$temporary/old/$index/name"; name=$value
  expected_hash=$(cat "$temporary/old/$index/hash")
  path=$directory/$name
  safe_path "$path"
  modified=false
  if ! entry_exists "$path" || [ ! -f "$path" ]; then modified=true
  else hash_file "$path"; [ "$file_hash" = "$expected_hash" ] || modified=true; fi
  if [ "$modified" = true ]; then
    modified_count=$((modified_count + 1))
    printf '%s' "$name" > "$temporary/modified/$modified_count"
  fi
  index=$((index + 1))
done
changed_bundle=false
if [ "$marker_valid" = true ] && { [ "$installed_version_json" != "$bundle_version_json" ] || [ "$old_count" -ne "$bundle_count" ]; }; then changed_bundle=true; fi
index=1
while [ "$index" -le "$bundle_count" ]; do
  read_value "$temporary/bundle/$index/name"; name=$value
  safe_path "$directory/$name"
  find_record "$temporary/old" "$name"
  if [ "$found_index" -eq 0 ]; then
    changed_bundle=true
    if entry_exists "$directory/$name"; then
      unmanaged_count=$((unmanaged_count + 1))
      printf '%s' "$name" > "$temporary/unmanaged/$unmanaged_count"
    fi
  elif ! cmp -s "$temporary/old/$found_index/hash" "$temporary/bundle/$index/hash"; then changed_bundle=true; fi
  index=$((index + 1))
done
if ! entry_exists "$directory"; then state=not-installed
elif [ "$marker_valid" = false ]; then state=unmanaged
elif [ "$modified_count" -gt 0 ]; then state=modified
elif [ "$unmanaged_count" -gt 0 ]; then state=unmanaged
elif [ "$changed_bundle" = true ]; then state=outdated
else state=current; fi

json_string() {
  LLMWIKI_JSON_VALUE=$1 awk 'BEGIN {
    for (i = 1; i < 32; i++) controls = controls sprintf("%c", i);
    text = ENVIRON["LLMWIKI_JSON_VALUE"]; printf "\"";
    for (i = 1; i <= length(text); i++) {
      c = substr(text, i, 1);
      if (c == "\"") printf "\\\"";
      else if (c == "\\") printf "\\\\";
      else if (c == "\b") printf "\\b";
      else if (c == "\f") printf "\\f";
      else if (c == "\n") printf "\\n";
      else if (c == "\r") printf "\\r";
      else if (c == "\t") printf "\\t";
      else if ((code = index(controls, c))) printf "\\u%04x", code;
      else printf "%s", c;
    }
    printf "\"";
  }'
}
json_list() {
  list_directory=$1
  list_count=$2
  printf '['
  list_index=1
  while [ "$list_index" -le "$list_count" ]; do
    [ "$list_index" -eq 1 ] || printf ', '
    read_value "$list_directory/$list_index"
    json_string "$value"
    list_index=$((list_index + 1))
  done
  printf ']'
}
print_status() {
  printf '{\n  "client": '; json_string "$client"
  printf ',\n  "directory": '; json_string "$directory"
  printf ',\n  "state": '; json_string "$state"
  printf ',\n  "installedVersion": %s,\n  "availableVersion": %s,\n  "modifiedFiles": ' "$installed_version_json" "$bundle_version_json"
  json_list "$temporary/modified" "$modified_count"
  printf ',\n  "unmanagedFiles": '; json_list "$temporary/unmanaged" "$unmanaged_count"
  if [ "$action" != status ]; then printf ',\n  "changed": %s' "$changed"; fi
  printf '\n}\n'
}
if [ "$interactive" = true ]; then
  printf '%s: %s (%s)\n' "$client" "$state" "$directory" >&2
  if [ "$action" = auto ]; then
    case $state in
      not-installed) action=install ;;
      current) action=status ;;
      *) action=update ;;
    esac
  fi
  if [ "$action" != status ] && [ "$force" = false ]; then
    case $state in
      modified|unmanaged)
        printf '%s\n' 'Local modifications or unmanaged files will be replaced by --force.' >&2
        while :; do
          prompt 'Overwrite skill files? [y/N]: '
          case $answer in
            y|Y|yes|YES) force=true; break ;;
            ''|n|N|no|NO) action=status; printf '%s\n' 'Skipped; no skill files were changed.' >&2; break ;;
            *) printf '%s\n' 'Answer yes or no.' >&2 ;;
          esac
        done
        ;;
    esac
  fi
fi
if [ "$action" != status ]; then
  if [ "$action" = update ] && [ "$state" = not-installed ]; then
    fail "Skill is not installed at $directory; run skill install $client first"
  fi
  marker_conflict=false
  if [ "$marker_valid" = false ] && entry_exists "$marker_path"; then marker_conflict=true; fi
  if [ "$force" = false ] && { [ "$modified_count" -gt 0 ] || [ "$unmanaged_count" -gt 0 ] || [ "$marker_conflict" = true ]; }; then
    printf 'Refusing to overwrite locally modified or unmanaged files: ' >&2
    json_list "$temporary/modified" "$modified_count" >&2
    printf ' ' >&2
    json_list "$temporary/unmanaged" "$unmanaged_count" >&2
    if [ "$marker_conflict" = true ]; then printf ' %s' "$marker_name" >&2; fi
    fail '. Review them and use --force to replace skill files only.'
  fi
  changed=false
  if [ "$state" != current ]; then
    # Preflight the complete union before writing anything, including retired files.
    for manifest in bundle old; do
      if [ "$manifest" = bundle ]; then count=$bundle_count; else count=$old_count; fi
      index=1
      while [ "$index" -le "$count" ]; do
        read_value "$temporary/$manifest/$index/name"
        preflight_file "$directory/$value"
        index=$((index + 1))
      done
    done
    preflight_file "$marker_path"
    mkdir -p "$directory"
    index=1
    while [ "$index" -le "$bundle_count" ]; do
      read_value "$temporary/bundle/$index/name"; path=$directory/$value
      mkdir -p "${path%/*}"
      cat "$temporary/bundle/$index/content" > "$path"
      index=$((index + 1))
    done
    index=1
    while [ "$index" -le "$old_count" ]; do
      read_value "$temporary/old/$index/name"; name=$value
      find_record "$temporary/bundle" "$name"
      if [ "$found_index" -eq 0 ] && entry_exists "$directory/$name"; then rm "$directory/$name"; fi
      index=$((index + 1))
    done
    {
      printf '{\n  "schema": 1,\n  "client": '; json_string "$client"
      printf ',\n  "version": %s,\n  "files": {' "$bundle_version_json"
      index=1
      while [ "$index" -le "$bundle_count" ]; do
        [ "$index" -eq 1 ] || printf ','
        printf '\n    '
        read_value "$temporary/bundle/$index/name"; json_string "$value"
        printf ': "%s"' "$(cat "$temporary/bundle/$index/hash")"
        index=$((index + 1))
      done
      printf '\n  }\n}\n'
    } > "$marker_path"
    installed_version_json=$bundle_version_json
    modified_count=0
    unmanaged_count=0
    state=current
    changed=true
  fi
fi
print_status
printf '\nSeparate MCP/OAuth step (not performed by this command):\n' >&2
printf '%s\n' 'For client setup and login, open <ENGINE_URL>/settings?tab=mcp or read docs/skills.md. Start a new agent session after installing.' >&2
if [ "$client" = hermes ] && [ "$project_set" = true ]; then
  printf '%s\n' 'Hermes project skills require a git project root and separate approval: hermes skills trust <PROJECT_DIR>. This command does not modify project trust.' >&2
fi
