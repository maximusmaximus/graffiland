import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  detectActiveEmojiToken,
  insertEmojiAtToken,
  replaceCompletedEmojiShortcodes,
  searchEmojiShortcodes
} from '../utils/emojiShortcodes.js';

function EmojiFieldBase({
  as = 'input',
  value = '',
  onChange,
  onKeyDown,
  onBlur,
  onClick,
  maxLength,
  wrapperClassName = '',
  wrapperStyle = undefined,
  ...rest
}) {
  const fieldRef = useRef(null);
  const rootRef = useRef(null);
  const pendingCaretRef = useRef(null);
  const listId = useId();
  const [caret, setCaret] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedTokenKey, setDismissedTokenKey] = useState('');

  const strValue = String(value ?? '');
  const activeToken = useMemo(() => {
    if (caret === null) return null;
    const tok = detectActiveEmojiToken(strValue, caret);
    if (!tok) return null;
    const tokKey = `${tok.start}:${tok.query}`;
    if (tokKey === dismissedTokenKey) return null;
    return tok;
  }, [strValue, caret, dismissedTokenKey]);

  const suggestions = useMemo(() => {
    if (!activeToken) return [];
    return searchEmojiShortcodes(activeToken.query, 8);
  }, [activeToken]);

  const isOpen = suggestions.length > 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [activeToken?.query]);

  useLayoutEffect(() => {
    const pending = pendingCaretRef.current;
    if (!pending) return;
    if (strValue !== pending.expectedValue) return;
    pendingCaretRef.current = null;
    const el = fieldRef.current;
    if (el && typeof el.setSelectionRange === 'function' && el.value === pending.expectedValue) {
      try {
        if (document.activeElement !== el) el.focus();
        el.setSelectionRange(pending.caret, pending.caret);
      } catch {
        // ignore on non-selectable inputs
      }
    }
  }, [strValue]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onOutside = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setCaret(null);
      }
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [isOpen]);

  const emitChange = useCallback(
    (nextVal, nextCaret) => {
      pendingCaretRef.current = { expectedValue: nextVal, caret: nextCaret };
      onChange?.({
        target: { value: nextVal },
        currentTarget: { value: nextVal }
      });
      setCaret(nextCaret);
      setDismissedTokenKey('');
    },
    [onChange]
  );

  const handleFieldChange = (e) => {
    const rawVal = e.target.value;
    const nextPos = e.target.selectionStart ?? rawVal.length;
    const completed = replaceCompletedEmojiShortcodes(rawVal, nextPos);
    if (completed) {
      let finalVal = completed.value;
      if (Number.isFinite(Number(maxLength)) && finalVal.length > Number(maxLength)) {
        finalVal = finalVal.slice(0, Number(maxLength));
      }
      emitChange(finalVal, Math.min(completed.caret, finalVal.length));
      return;
    }
    pendingCaretRef.current = null;
    setDismissedTokenKey('');
    setCaret(nextPos);
    onChange?.(e);
  };

  const applySuggestion = (item) => {
    if (!activeToken || !item?.emoji) return;
    const out = insertEmojiAtToken(strValue, activeToken, item.emoji, maxLength);
    emitChange(out.value, out.caret);
    setCaret(null);
  };

  const handleKeyDown = (e) => {
    if (isOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((idx) => (idx + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((idx) => (idx - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applySuggestion(suggestions[activeIndex] || suggestions[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (activeToken) setDismissedTokenKey(`${activeToken.start}:${activeToken.query}`);
        return;
      }
    }
    onKeyDown?.(e);
  };

  const handleSelectOrClick = (e) => {
    setCaret(e.target.selectionStart ?? String(e.target.value || '').length);
    onClick?.(e);
  };

  const handleBlur = (e) => {
    setTimeout(() => {
      if (rootRef.current && !rootRef.current.contains(document.activeElement)) {
        setCaret(null);
      }
    }, 120);
    onBlur?.(e);
  };

  const Tag = as === 'textarea' ? 'textarea' : 'input';
  const sharedProps = {
    ref: fieldRef,
    ...(as === 'input' ? { type: rest.type || 'text' } : {}),
    ...rest,
    value: strValue,
    maxLength,
    'aria-autocomplete': 'list',
    'aria-controls': isOpen ? listId : undefined,
    onChange: handleFieldChange,
    onKeyDown: handleKeyDown,
    onClick: handleSelectOrClick,
    onKeyUp: (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
        setCaret(e.target.selectionStart ?? String(e.target.value || '').length);
      }
    },
    onBlur: handleBlur
  };

  return (
    <div
      ref={rootRef}
      className={`emoji-field-wrap ${wrapperClassName}`}
      style={wrapperStyle}
    >
      <Tag {...sharedProps} />
      {isOpen && (
        <div
          id={listId}
          role="listbox"
          aria-label="Emoji suggestions"
          className="emoji-picker-popover"
        >
          {suggestions.map((item, idx) => (
            <button
              key={`${item.shortcode}-${item.emoji}`}
              type="button"
              role="option"
              aria-selected={idx === activeIndex}
              className={`emoji-picker-option ${idx === activeIndex ? 'is-active' : ''}`}
              onMouseDown={(ev) => {
                ev.preventDefault();
              }}
              onClick={(ev) => {
                ev.preventDefault();
                applySuggestion(item);
              }}
            >
              <span className="emoji-picker-glyph" aria-hidden="true">
                {item.emoji}
              </span>
              <span className="emoji-picker-code mono">:{item.shortcode}:</span>
              <span className="emoji-picker-name">{item.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function EmojiInput(props) {
  return <EmojiFieldBase as="input" {...props} />;
}

export function EmojiTextarea(props) {
  return <EmojiFieldBase as="textarea" {...props} />;
}

export default EmojiInput;
