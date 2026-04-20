import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadAllRules,
  loadRulesCsv,
  parseCsv,
} from '../../lib/core/rules-csv-loader.js';

const HEADER = 'domain,rule_id,severity,context,description,rationale';

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'rules-csv-test-'));
}

describe('rules-csv-loader', () => {
  describe('parseCsv', () => {
    it('parses a basic header + three rows', () => {
      const csv = [
        HEADER,
        'backend,api-1,error,routes,Use proper status codes,HTTP semantics',
        'backend,api-2,warn,routes,Paginate list endpoints,Scale',
        'frontend,ui-1,error,components,Avoid inline styles,Maintainability',
      ].join('\n');
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(3);
      expect(rows[0].domain).toBe('backend');
      expect(rows[0].rule_id).toBe('api-1');
      expect(rows[2].rule_id).toBe('ui-1');
    });

    it('supports quoted fields that contain commas', () => {
      const csv = `${HEADER}\nbackend,api-3,error,routes,"Use zod, joi, or yup","Validation, strict"`;
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBe('Use zod, joi, or yup');
      expect(rows[0].rationale).toBe('Validation, strict');
    });

    it('supports escaped double quotes inside quoted fields', () => {
      const csv = `${HEADER}\nbackend,api-4,warn,routes,"Say ""hi""","Escape""me"`;
      const rows = parseCsv(csv);
      expect(rows[0].description).toBe('Say "hi"');
      expect(rows[0].rationale).toBe('Escape"me');
    });

    it('handles CRLF line endings', () => {
      const csv = `${HEADER}\r\nbackend,api-5,error,routes,Desc,Why\r\n`;
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(1);
      expect(rows[0].rule_id).toBe('api-5');
    });

    it('skips blank lines in the body', () => {
      const csv = [
        HEADER,
        '',
        'backend,api-6,error,routes,Desc,Why',
        '',
        'backend,api-7,warn,routes,Desc2,Why2',
      ].join('\n');
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(2);
      expect(rows[0].rule_id).toBe('api-6');
      expect(rows[1].rule_id).toBe('api-7');
    });

    it('tolerates a trailing newline', () => {
      const csv = `${HEADER}\nbackend,api-8,error,routes,Desc,Why\n`;
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(1);
    });

    it('returns [] for empty input', () => {
      expect(parseCsv('')).toEqual([]);
    });

    it('skips malformed rows (wrong column count) without throwing', () => {
      const csv = [
        HEADER,
        'backend,api-9,error,routes,OnlyFiveCols',
        'backend,api-10,error,routes,GoodDesc,GoodRationale',
      ].join('\n');
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(1);
      expect(rows[0].rule_id).toBe('api-10');
    });

    it('preserves Unicode/Korean content intact', () => {
      const csv = `${HEADER}\nbackend,api-11,error,routes,한글 설명,이유 설명`;
      const rows = parseCsv(csv);
      expect(rows[0].description).toBe('한글 설명');
      expect(rows[0].rationale).toBe('이유 설명');
    });
  });

  describe('loadRulesCsv', () => {
    it('reads a file from disk and returns Rule objects', async () => {
      const dir = makeTmpDir();
      try {
        const file = path.join(dir, 'backend.csv');
        const csv = `${HEADER}\nbackend,api-1,error,routes,Desc,Why`;
        writeFileSync(file, csv, 'utf-8');
        const rules = await loadRulesCsv(file);
        expect(rules).toHaveLength(1);
        expect(rules[0]).toEqual({
          domain: 'backend',
          rule_id: 'api-1',
          severity: 'error',
          context: 'routes',
          description: 'Desc',
          rationale: 'Why',
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns [] when the file is missing (no throw)', async () => {
      const missing = path.join(tmpdir(), 'does-not-exist-xyz.csv');
      const rules = await loadRulesCsv(missing);
      expect(rules).toEqual([]);
    });
  });

  describe('loadAllRules', () => {
    it('merges rules from every .csv in a directory', async () => {
      const dir = makeTmpDir();
      try {
        writeFileSync(
          path.join(dir, 'backend.csv'),
          `${HEADER}\nbackend,api-1,error,routes,Desc,Why`,
          'utf-8'
        );
        writeFileSync(
          path.join(dir, 'frontend.csv'),
          `${HEADER}\nfrontend,ui-1,warn,components,Desc,Why`,
          'utf-8'
        );
        const rules = await loadAllRules(dir);
        expect(rules).toHaveLength(2);
        const ids = rules.map((r) => r.rule_id).sort();
        expect(ids).toEqual(['api-1', 'ui-1']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('skips files prefixed with an underscore (drafts)', async () => {
      const dir = makeTmpDir();
      try {
        writeFileSync(
          path.join(dir, 'backend.csv'),
          `${HEADER}\nbackend,api-1,error,routes,Desc,Why`,
          'utf-8'
        );
        writeFileSync(
          path.join(dir, '_draft_frontend.csv'),
          `${HEADER}\nfrontend,ui-1,warn,components,Desc,Why`,
          'utf-8'
        );
        const rules = await loadAllRules(dir);
        expect(rules).toHaveLength(1);
        expect(rules[0].rule_id).toBe('api-1');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns [] for a missing directory', async () => {
      const missing = path.join(tmpdir(), 'rules-csv-missing-xyz');
      const rules = await loadAllRules(missing);
      expect(rules).toEqual([]);
    });
  });
});
