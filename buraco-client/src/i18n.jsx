// ─── i18n ─────────────────────────────────────────────────────────────────────
// Lightweight translation module: a LanguageProvider context + useT() hook.
//
//  const { t, tN, lang, setLang } = useT();
//  t('lounge.quickGame')                    → "Jogo Rápido"
//  t('tourney.format.points', { pts: 3000 }) → "PONTOS (Meta: 3000 pts)"
//  tN('gameover.winner', 2, { names: 'A, B' }) → "Vencedores: A, B (2 pts)"
//
// Language is auto-detected from navigator.language on startup, with a manual
// override persisted in localStorage under 'buraco_lang'. <html lang> is kept
// in sync.
// ─────────────────────────────────────────────────────────────────────────────

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { messages as pt } from './locales/pt.js';
import { messages as en } from './locales/en.js';
import { messages as it } from './locales/it.js';

const LOCALES = { pt, en, it };
const LANGS = ['pt', 'en', 'it'];
const LANG_LABELS = { pt: 'Português', en: 'English', it: 'Italiano' };
const STORAGE_KEY = 'buraco_lang';

function normalizeLang(candidate) {
  if (!candidate) return null;
  const c = String(candidate).toLowerCase().replace('-', '_');
  for (const l of LANGS) {
    if (c === l || c.startsWith(l + '_')) return l;
  }
  return null;
}

function detectLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const fromSave = normalizeLang(saved);
    if (fromSave) return fromSave;
  } catch { /* localStorage unavailable */ }
  const nav = (typeof navigator !== 'undefined' && navigator.language) ||
    (typeof navigator !== 'undefined' && navigator.languages && navigator.languages[0]) || 'pt';
  return normalizeLang(nav) || 'pt';
}

function lookup(messages, key) {
  const parts = key.split('.');
  let cur = messages;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(str, params) {
  if (!str || !params) return str || '';
  return str.replace(/\{(\w+)\}/g, (m, name) => {
    const v = params[name];
    return v === undefined || v === null ? m : String(v);
  });
}

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => detectLang());

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo(() => {
    const messages = LOCALES[lang] || LOCALES.pt;
    let pluralRules = null;
    try { pluralRules = new Intl.PluralRules(lang); } catch { /* ignore */ }

    const t = (key, params) => {
      let str = lookup(messages, key);
      if (str === undefined) str = lookup(LOCALES.pt, key);
      return interpolate(str === undefined ? key : str, params);
    };
    const tN = (key, n, params = {}) => {
      let cat = 'other';
      if (pluralRules) {
        try { cat = pluralRules.select(n); } catch { /* ignore */ }
      }
      let str = lookup(messages, `${key}.${cat}`);
      if (str === undefined) str = lookup(messages, `${key}.other`);
      if (str === undefined) str = lookup(LOCALES.pt, `${key}.${cat}`);
      if (str === undefined) str = lookup(LOCALES.pt, `${key}.other`);
      if (str === undefined) str = lookup(messages, key);
      return interpolate(str === undefined ? key : str, { ...params, n });
    };
    const setLang = (l) => {
      const norm = normalizeLang(l);
      if (norm) setLangState(norm);
    };
    return { t, tN, lang, setLang, availableLangs: LANGS, langLabel: (l) => LANG_LABELS[l] || l };
  }, [lang]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useT() {
  return useContext(LanguageContext);
}
