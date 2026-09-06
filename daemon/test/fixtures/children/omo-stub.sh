#!/bin/sh

prompt=""
for argument in "$@"; do
  prompt="$argument"
done

case "$prompt" in
  *CRASH*)
    printf '%s\n' '{"state":"failed","summary":"fixture crash","errorCode":"fixture_crash","errorMessage":"fixture exited intentionally"}'
    exit 17
    ;;
  *HANG*)
    child_pid=""
    if [ -n "${OMO_STUB_CHILD_PID_FILE:-}" ]; then
      sleep 300 &
      child_pid=$!
      printf '%s' "$child_pid" > "$OMO_STUB_CHILD_PID_FILE"
    fi
    trap 'printf "%s\n" "{\"state\":\"cancelled\",\"summary\":\"fixture cancelled\"}"; wait "$child_pid" 2>/dev/null; exit 0' TERM INT
    while :; do sleep 1; done
    ;;
  *AGENT_END*)
    printf '%s\n' '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"agent end result"}]}]}'
    exit 0
    ;;
  *MULTI*)
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"fixture "}}'
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"result"}}'
    exit 0
    ;;
  *STDERR_PROGRESS*)
    printf '%s\n' 'working' >&2
    printf '%s\n' '{"state":"completed","summary":"stderr progress result"}'
    exit 0
    ;;
  *)
    printf '%s\n' '{"state":"completed","summary":"fixture result"}'
    ;;
esac
