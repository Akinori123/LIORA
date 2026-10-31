import test from 'node:test';
import assert from 'node:assert';
import { 
  canonicalizeDeterministicSubset, 
  computeParametersHash, 
  CanonicalizationError,
  deepFreeze 
} from '../src/security/canonicalizer';

test('1. Canonicalizer - Object key ordering is deterministic and produces identical SHA-256 hash', () => {
  const obj1 = { b: 2, a: 1, z: 99, m: 'middle' };
  const obj2 = { m: 'middle', z: 99, a: 1, b: 2 };

  const canon1 = canonicalizeDeterministicSubset(obj1);
  const canon2 = canonicalizeDeterministicSubset(obj2);

  assert.strictEqual(canon1, '{"a":1,"b":2,"m":"middle","z":99}');
  assert.strictEqual(canon2, '{"a":1,"b":2,"m":"middle","z":99}');

  const hash1 = computeParametersHash(obj1);
  const hash2 = computeParametersHash(obj2);
  assert.strictEqual(hash1, hash2);
  assert.strictEqual(typeof hash1, 'string');
  assert.strictEqual(hash1.length, 64); // SHA-256 hex
});

test('2. Canonicalizer - Nested objects and arrays are correctly canonicalized', () => {
  const nested = {
    user: {
      profile: { name: 'Alice', age: 30 },
      roles: ['admin', 'developer']
    },
    active: true,
    metadata: null
  };

  const canon = canonicalizeDeterministicSubset(nested);
  assert.strictEqual(
    canon,
    '{"active":true,"metadata":null,"user":{"profile":{"age":30,"name":"Alice"},"roles":["admin","developer"]}}'
  );
});

test('3. Canonicalizer - Unicode strings are handled deterministically', () => {
  const unicodeObj = {
    accent: 'Olá mundo! Ação e reação 🚀',
    japanese: 'こんにちは',
    escapes: 'Line1\nLine2\t"Quote"'
  };

  const canon1 = canonicalizeDeterministicSubset(unicodeObj);
  const canon2 = canonicalizeDeterministicSubset(unicodeObj);
  assert.strictEqual(canon1, canon2);
  assert.ok(canon1.includes('こんにちは'));
  assert.ok(canon1.includes('🚀'));
});

test('4. Canonicalizer - Finite numbers, negative zero, and numeric boundaries', () => {
  assert.strictEqual(canonicalizeDeterministicSubset(0), '0');
  assert.strictEqual(canonicalizeDeterministicSubset(-0), '0'); // -0 normalizado para 0
  assert.strictEqual(canonicalizeDeterministicSubset(42), '42');
  assert.strictEqual(canonicalizeDeterministicSubset(-100.5), '-100.5');
  assert.strictEqual(canonicalizeDeterministicSubset(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER));
  assert.strictEqual(canonicalizeDeterministicSubset(Number.MIN_SAFE_INTEGER), String(Number.MIN_SAFE_INTEGER));

  // Rejeição de números não finitos
  assert.throws(() => canonicalizeDeterministicSubset(NaN), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_INVALID_NUMBER'
  });
  assert.throws(() => canonicalizeDeterministicSubset(Infinity), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_INVALID_NUMBER'
  });
  assert.throws(() => canonicalizeDeterministicSubset(-Infinity), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_INVALID_NUMBER'
  });
});

test('5. Canonicalizer - Rejection of undefined at any depth', () => {
  // Undefined na raiz
  assert.throws(() => canonicalizeDeterministicSubset(undefined), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_REJECTED_UNDEFINED'
  });

  // Undefined como propriedade de objeto
  assert.throws(() => canonicalizeDeterministicSubset({ a: 1, b: undefined }), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_REJECTED_UNDEFINED'
  });

  // Undefined aninhado
  assert.throws(() => canonicalizeDeterministicSubset({ outer: { inner: undefined } }), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_REJECTED_UNDEFINED'
  });

  // Undefined dentro de array
  assert.throws(() => canonicalizeDeterministicSubset([1, undefined, 3]), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_REJECTED_UNDEFINED'
  });
});

test('6. Canonicalizer - Rejection of circular references', () => {
  const circularObj: any = { name: 'circular' };
  circularObj.self = circularObj;

  assert.throws(() => canonicalizeDeterministicSubset(circularObj), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_CIRCULAR_REFERENCE'
  });

  const circularArr: any = [1, 2];
  circularArr.push(circularArr);

  assert.throws(() => canonicalizeDeterministicSubset(circularArr), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_CIRCULAR_REFERENCE'
  });
});

test('7. Canonicalizer - Shared non-circular references (DAG) are accepted', () => {
  const sharedChild = { key: 'value', number: 42 };
  const dag = {
    branchA: sharedChild,
    branchB: sharedChild
  };

  // Não deve lançar erro porque sharedChild não é ancestral de si mesmo
  const canon = canonicalizeDeterministicSubset(dag);
  assert.strictEqual(
    canon,
    '{"branchA":{"key":"value","number":42},"branchB":{"key":"value","number":42}}'
  );
});

test('8. Canonicalizer - Rejection of non-plain objects (classes, Date, RegExp, Map, Error)', () => {
  class CustomClass {
    public value = 123;
  }

  assert.throws(() => canonicalizeDeterministicSubset(new CustomClass()), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_NON_PLAIN_OBJECT'
  });

  assert.throws(() => canonicalizeDeterministicSubset(new Date()), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_NON_PLAIN_OBJECT'
  });

  assert.throws(() => canonicalizeDeterministicSubset(/abc/g), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_NON_PLAIN_OBJECT'
  });

  assert.throws(() => canonicalizeDeterministicSubset(new Map()), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_NON_PLAIN_OBJECT'
  });

  assert.throws(() => canonicalizeDeterministicSubset(new Error('test')), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_NON_PLAIN_OBJECT'
  });

  // Objeto criado com Object.create(null) DEVE ser aceito (protótipo null)
  const nullProtoObj = Object.create(null);
  nullProtoObj.foo = 'bar';
  assert.strictEqual(canonicalizeDeterministicSubset(nullProtoObj), '{"foo":"bar"}');
});

test('9. Canonicalizer - Rejection of dangerous property keys (__proto__, constructor, prototype)', () => {
  const dangerous1 = JSON.parse('{"__proto__": "polluted", "a": 1}');
  assert.throws(() => canonicalizeDeterministicSubset(dangerous1), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_FORBIDDEN_KEY'
  });

  const dangerous2 = { constructor: 'fake', a: 1 };
  assert.throws(() => canonicalizeDeterministicSubset(dangerous2), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_FORBIDDEN_KEY'
  });

  const dangerous3 = { prototype: 'evil', b: 2 };
  assert.throws(() => canonicalizeDeterministicSubset(dangerous3), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_FORBIDDEN_KEY'
  });
});

test('10. Canonicalizer - Rejection of Symbol property keys', () => {
  const symKey = Symbol('secret');
  const objWithSymbol = { normal: 'val' };
  (objWithSymbol as any)[symKey] = 'hidden';

  assert.throws(() => canonicalizeDeterministicSubset(objWithSymbol), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_FORBIDDEN_SYMBOL_KEY'
  });
});

test('11. Canonicalizer - Rejection of accessor properties without executing getters (Verified with Spy)', () => {
  let getterInvocationCount = 0;
  let setterInvocationCount = 0;

  const objWithAccessor = {};
  Object.defineProperty(objWithAccessor, 'secret', {
    enumerable: true,
    configurable: true,
    get() {
      getterInvocationCount++;
      return 'sensitive-value';
    },
    set(v) {
      setterInvocationCount++;
    }
  });

  assert.throws(() => canonicalizeDeterministicSubset(objWithAccessor), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_ACCESSOR_PROPERTY'
  });

  // COMPROVAÇÃO RIGOROSA: O getter JAMAIS foi executado
  assert.strictEqual(getterInvocationCount, 0, 'O getter NÃO deve ter sido executado durante a canonicalização');
  assert.strictEqual(setterInvocationCount, 0, 'O setter NÃO deve ter sido executado');
});

test('12. Canonicalizer - Rejection of sparse arrays and additional non-index properties', () => {
  // Array com buracos (esparso)
  const sparseArr = new Array(3);
  sparseArr[0] = 'a';
  sparseArr[2] = 'c';

  assert.throws(() => canonicalizeDeterministicSubset(sparseArr), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_SPARSE_ARRAY'
  });

  // Array com propriedade extra não-numérica
  const arrWithProp = [1, 2, 3];
  (arrWithProp as any).extra = 'injected';

  assert.throws(() => canonicalizeDeterministicSubset(arrWithProp), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_ARRAY_EXTRA_PROPERTIES'
  });
});

test('13. Canonicalizer - Rejection of BigInt, functions, and symbols as values', () => {
  assert.throws(() => canonicalizeDeterministicSubset(BigInt(12345)), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_UNSUPPORTED_TYPE'
  });

  assert.throws(() => canonicalizeDeterministicSubset(() => 42), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_UNSUPPORTED_TYPE'
  });

  assert.throws(() => canonicalizeDeterministicSubset(Symbol('token')), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_UNSUPPORTED_TYPE'
  });

  assert.throws(() => canonicalizeDeterministicSubset({ fn: () => {} }), {
    name: 'CanonicalizationError',
    code: 'CANONICALIZATION_UNSUPPORTED_TYPE'
  });
});

test('14. Canonicalizer - deepFreeze prevents accidental or malicious mutations', () => {
  const original = {
    settings: { timeout: 5000, enabled: true },
    list: [1, 2, 3]
  };

  const frozen = deepFreeze(original);

  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.settings));
  assert.ok(Object.isFrozen(frozen.list));

  // Tentativa de mutação em strict mode lança erro ou falha silenciosamente
  assert.throws(() => {
    'use strict';
    (frozen.settings as any).timeout = 9999;
  });
  assert.strictEqual(frozen.settings.timeout, 5000);
});
