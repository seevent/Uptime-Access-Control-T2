const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const CATEGORIES = [
    {
        id: 1,
        name: "Terminal 2",
        subcategories: [
            { id: 11, name: "CCTV" },
            { id: 12, name: "Akses" },
        ],
    },
    { id: 2, name: "Terminal 3", subcategories: [{ id: 21, name: "CCTV" }] },
];

const DEVICES = [
    { id: 1, categoryId: 1, subcategoryId: 11 },
    { id: 2, categoryId: 1, subcategoryId: 12 },
    { id: 3, categoryId: 1, subcategoryId: null },
    { id: 4, categoryId: 2, subcategoryId: 21 },
    { id: 5, categoryId: null, subcategoryId: null },
];

const ids = (list) => list.map((d) => d.id);

describe("network device filter", () => {
    let m;

    before(async () => {
        m = await import("../../src/network-device-filter.js");
    });

    test("isFilterActive is true as soon as a category is chosen", () => {
        assert.equal(m.isFilterActive({ categoryId: null, subcategoryId: null }), false);
        assert.equal(m.isFilterActive({ categoryId: 1, subcategoryId: null }), true);
        assert.equal(m.isFilterActive({ categoryId: "none", subcategoryId: null }), true);
    });

    test("filterDevices without a category returns every device", () => {
        assert.deepEqual(ids(m.filterDevices(DEVICES, { categoryId: null, subcategoryId: null })), [1, 2, 3, 4, 5]);
    });

    test("filterDevices by category, by category and sub category, and without category", () => {
        assert.deepEqual(ids(m.filterDevices(DEVICES, { categoryId: 1, subcategoryId: null })), [1, 2, 3]);
        assert.deepEqual(ids(m.filterDevices(DEVICES, { categoryId: 1, subcategoryId: 11 })), [1]);
        assert.deepEqual(ids(m.filterDevices(DEVICES, { categoryId: "none", subcategoryId: null })), [5]);
        assert.deepEqual(ids(m.filterDevices(DEVICES, { categoryId: 99, subcategoryId: null })), []);
    });

    test("filterDevices does not change the list it is given", () => {
        const copy = JSON.parse(JSON.stringify(DEVICES));
        m.filterDevices(DEVICES, { categoryId: 1, subcategoryId: 11 });
        assert.deepEqual(DEVICES, copy);
    });

    test("normalizeFilter keeps a filter that is still valid", () => {
        assert.deepEqual(m.normalizeFilter({ categoryId: 1, subcategoryId: 11 }, CATEGORIES), {
            categoryId: 1,
            subcategoryId: 11,
        });
        assert.deepEqual(m.normalizeFilter({ categoryId: "none", subcategoryId: null }, CATEGORIES), {
            categoryId: "none",
            subcategoryId: null,
        });
    });

    test("normalizeFilter goes back to all when the category is gone", () => {
        assert.deepEqual(m.normalizeFilter({ categoryId: 99, subcategoryId: 11 }, CATEGORIES), {
            categoryId: null,
            subcategoryId: null,
        });
    });

    test("normalizeFilter drops a sub category that is gone or belongs to another category", () => {
        assert.deepEqual(m.normalizeFilter({ categoryId: 1, subcategoryId: 99 }, CATEGORIES), {
            categoryId: 1,
            subcategoryId: null,
        });
        assert.deepEqual(m.normalizeFilter({ categoryId: 1, subcategoryId: 21 }, CATEGORIES), {
            categoryId: 1,
            subcategoryId: null,
        });
        assert.deepEqual(m.normalizeFilter({ categoryId: "none", subcategoryId: 11 }, CATEGORIES), {
            categoryId: "none",
            subcategoryId: null,
        });
    });

    test("filterLabel names the filter, and is empty when there is none", () => {
        const none = "Tanpa kategori";
        assert.equal(m.filterLabel({ categoryId: null, subcategoryId: null }, CATEGORIES, none), "");
        assert.equal(m.filterLabel({ categoryId: 1, subcategoryId: null }, CATEGORIES, none), "Terminal 2");
        assert.equal(m.filterLabel({ categoryId: 1, subcategoryId: 11 }, CATEGORIES, none), "Terminal 2 › CCTV");
        assert.equal(m.filterLabel({ categoryId: "none", subcategoryId: null }, CATEGORIES, none), none);
    });

    test("categoryNames gives the names of the category and sub category, or empty text", () => {
        assert.deepEqual(m.categoryNames(DEVICES[0], CATEGORIES), { category: "Terminal 2", subcategory: "CCTV" });
        assert.deepEqual(m.categoryNames(DEVICES[2], CATEGORIES), { category: "Terminal 2", subcategory: "" });
        assert.deepEqual(m.categoryNames(DEVICES[4], CATEGORIES), { category: "", subcategory: "" });
    });
});
