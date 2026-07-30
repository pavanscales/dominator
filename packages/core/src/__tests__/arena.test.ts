import { describe, it, expect, beforeEach } from 'vitest';
import {
    arenaAllocNum, arenaAllocStr, arenaAllocBool, arenaAllocObj,
    arenaReadNum, arenaReadStr, arenaReadBool, arenaReadObj, arenaReadRaw,
    arenaWriteNum, arenaWriteStr, arenaWriteBool, arenaWriteObj,
    arenaSize, arenaReset, arenaGetNumView, arenaGetTagView,
    TAG_NUMBER, TAG_STRING, TAG_BOOLEAN, TAG_OBJECT,
} from '../arena';

describe('arena', () => {
    beforeEach(() => {
        arenaReset();
    });

    it('allocates and reads numbers', () => {
        const id = arenaAllocNum(42);
        expect(arenaReadNum(id)).toBe(42);
        expect(arenaReadTag(id)).toBe(TAG_NUMBER);
    });

    it('allocates and reads strings', () => {
        const id = arenaAllocStr('hello');
        expect(arenaReadStr(id)).toBe('hello');
        expect(arenaReadTag(id)).toBe(TAG_STRING);
    });

    it('allocates and reads booleans', () => {
        const id = arenaAllocBool(true);
        expect(arenaReadBool(id)).toBe(true);
        expect(arenaReadTag(id)).toBe(TAG_BOOLEAN);
    });

    it('allocates and reads objects', () => {
        const obj = { x: 1, y: 2 };
        const id = arenaAllocObj(obj);
        expect(arenaReadObj(id)).toBe(obj);
        expect(arenaReadTag(id)).toBe(TAG_OBJECT);
    });

    it('writes numbers with change detection', () => {
        const id = arenaAllocNum(10);
        expect(arenaWriteNum(id, 10)).toBe(false); // same value
        expect(arenaWriteNum(id, 20)).toBe(true);  // different value
        expect(arenaReadNum(id)).toBe(20);
    });

    it('writes strings with hash-based change detection', () => {
        const id = arenaAllocStr('foo');
        expect(arenaWriteStr(id, 'foo')).toBe(false); // same string
        expect(arenaWriteStr(id, 'bar')).toBe(true);  // different string
        expect(arenaReadStr(id)).toBe('bar');
    });

    it('writes booleans with change detection', () => {
        const id = arenaAllocBool(false);
        expect(arenaWriteBool(id, false)).toBe(false);
        expect(arenaWriteBool(id, true)).toBe(true);
        expect(arenaReadBool(id)).toBe(true);
    });

    it('writes objects with reference equality', () => {
        const obj1 = { a: 1 };
        const obj2 = { b: 2 };
        const id = arenaAllocObj(obj1);
        expect(arenaWriteObj(id, obj1)).toBe(false); // same ref
        expect(arenaWriteObj(id, obj2)).toBe(true);  // different ref
        expect(arenaReadObj(id)).toBe(obj2);
    });

    it('tracks size correctly', () => {
        expect(arenaSize()).toBe(0);
        arenaAllocNum(1);
        arenaAllocNum(2);
        arenaAllocStr('x');
        expect(arenaSize()).toBe(3);
    });

    it('reads raw values by tag', () => {
        const nId = arenaAllocNum(99);
        const sId = arenaAllocStr('test');
        const bId = arenaAllocBool(true);
        expect(arenaReadRaw(nId)).toBe(99);
        expect(arenaReadRaw(sId)).toBe('test');
        expect(arenaReadRaw(bId)).toBe(true);
    });

    it('provides typed array views', () => {
        arenaAllocNum(1.5);
        arenaAllocNum(2.5);
        const nums = arenaGetNumView();
        expect(nums[0]).toBe(1.5);
        expect(nums[1]).toBe(2.5);

        const tags = arenaGetTagView();
        expect(tags[0]).toBe(TAG_NUMBER);
        expect(tags[1]).toBe(TAG_NUMBER);
    });

    it('handles rapid allocation (growth)', () => {
        for (let i = 0; i < 10000; i++) {
            arenaAllocNum(i);
        }
        expect(arenaSize()).toBe(10000);
        expect(arenaReadNum(9999)).toBe(9999);
    });

    it('resets cleanly', () => {
        arenaAllocNum(1);
        arenaAllocStr('x');
        arenaReset();
        expect(arenaSize()).toBe(0);
    });
});

function arenaReadTag(id: number): number {
    return arenaGetTagView()[id];
}
