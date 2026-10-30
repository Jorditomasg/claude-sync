import { expect, test } from 'claude-code/testing'
import { canonical, sha256 } from '../hooks/hash'
import { detectLang, strings } from '../hooks/i18n'

test('the language follows Claude, then the locale, English by default', () => {
  expect(detectLang('spanish', {})).toBe('es')
  expect(detectLang('Español', {})).toBe('es')
  expect(detectLang('english', { LANG: 'es_ES.UTF-8' })).toBe('en')
  expect(detectLang(undefined, { LANG: 'es_ES.UTF-8' })).toBe('es')
  expect(detectLang(undefined, { LC_ALL: 'en_US.UTF-8', LANG: 'es_ES' })).toBe('en')
  expect(detectLang(undefined, { LANG: 'C' }, 'es-ES')).toBe('es')
  expect(detectLang(undefined, {}, 'en-US')).toBe('en')
  expect(detectLang(undefined, {})).toBe('en')
})

test('both languages have every text', () => {
  expect(Object.keys(strings.es).sort()).toEqual(Object.keys(strings.en).sort())
  expect(Object.keys(strings.es.status).sort()).toEqual(Object.keys(strings.en.status).sort())
  expect(Object.keys(strings.es.kind).sort()).toEqual(Object.keys(strings.en.kind).sort())
})

test('hashes are stable whatever the key order', async () => {
  expect(canonical({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}')
  expect(await sha256(canonical({ x: 1, y: 2 }))).toBe(await sha256(canonical({ y: 2, x: 1 })))
  expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
