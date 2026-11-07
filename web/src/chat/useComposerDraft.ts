import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { draftKey, EMPTY, loadDraft, NO_DRAFT, sendDraft, setDraft, useDraftsStore } from "./drafts";

export function useComposerDraft(userId: string | undefined, target: readonly string[] | null, editing: string | null) {
  const key = draftKey(userId, target);
  const record = useDraftsStore(state => key ? state.entries[key] ?? EMPTY : NO_DRAFT);
  const [editText, setEditText] = useState("");
  const activeEdit = useRef({ key, editing, editText }); activeEdit.current = { key, editing, editText };
  useLayoutEffect(() => setEditText(""), [key]);
  useEffect(() => { if (key && userId) void loadDraft(key, userId); }, [key, userId]);
  const changeDraft: Dispatch<SetStateAction<string>> = useCallback(value => { if (key && userId) setDraft(key, userId, value); }, [key, userId]);
  const setText = editing ? setEditText : changeDraft;
  const send = useCallback((action: () => Promise<void>) => key && userId ? sendDraft(key, userId, action) : Promise.resolve(false), [key, userId]);
  const saveEdit = useCallback(async (action: () => Promise<void>) => {
    if (!key || !userId) return false;
    const before = activeEdit.current;
    const saved = await sendDraft(key, userId, action, false);
    const after = activeEdit.current;
    return saved && after.key === before.key && after.editing === before.editing && after.editText === before.editText;
  }, [key, userId]);
  return { key, text: editing ? editText : record.text, setText, setEditText, send, saveEdit,
    ready: record.ready,
    sending: record.sending, error: record.error };
}
