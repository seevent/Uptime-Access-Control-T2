/**
 * A category filter: `categoryId` is null (all devices), "none" (devices without a category) or a category id;
 * `subcategoryId` is null or a sub category id of that category.
 * @typedef {{categoryId: null|"none"|number, subcategoryId: null|number}} CategoryFilter
 */

/**
 * @param {CategoryFilter} filter The filter
 * @returns {boolean} True when the filter limits the devices
 */
export function isFilterActive(filter) {
    return filter.categoryId !== null;
}

/**
 * Keep the devices that match the filter.
 * @param {object[]} devices Devices with `categoryId` and `subcategoryId`
 * @param {CategoryFilter} filter The filter
 * @returns {object[]} A new list of the matching devices, in the same order
 */
export function filterDevices(devices, filter) {
    if (filter.categoryId === null) {
        return [...devices];
    }
    if (filter.categoryId === "none") {
        return devices.filter((device) => device.categoryId === null);
    }
    return devices.filter(
        (device) =>
            device.categoryId === filter.categoryId &&
            (filter.subcategoryId === null || device.subcategoryId === filter.subcategoryId)
    );
}

/**
 * Make a filter valid for the categories that exist now: a category or sub category that is gone is dropped.
 * @param {CategoryFilter} filter The filter
 * @param {{id: number, subcategories: {id: number}[]}[]} categories Categories with their sub categories
 * @returns {CategoryFilter} A new filter
 */
export function normalizeFilter(filter, categories) {
    if (filter.categoryId === null) {
        return { categoryId: null, subcategoryId: null };
    }
    if (filter.categoryId === "none") {
        return { categoryId: "none", subcategoryId: null };
    }
    const category = categories.find((c) => c.id === filter.categoryId);
    if (!category) {
        return { categoryId: null, subcategoryId: null };
    }
    const subExists = category.subcategories.some((sub) => sub.id === filter.subcategoryId);
    return { categoryId: category.id, subcategoryId: subExists ? filter.subcategoryId : null };
}

/**
 * Name the filter, for example for the title of a dialog.
 * @param {CategoryFilter} filter The filter
 * @param {{id: number, name: string, subcategories: {id: number, name: string}[]}[]} categories Categories
 * @param {string} noCategoryText Text for devices without a category
 * @returns {string} "Terminal 2", "Terminal 2 › CCTV", the text for no category, or "" when there is no filter
 */
export function filterLabel(filter, categories, noCategoryText) {
    if (filter.categoryId === null) {
        return "";
    }
    if (filter.categoryId === "none") {
        return noCategoryText;
    }
    const category = categories.find((c) => c.id === filter.categoryId);
    if (!category) {
        return "";
    }
    const sub = category.subcategories.find((s) => s.id === filter.subcategoryId);
    return sub ? `${category.name} › ${sub.name}` : category.name;
}

/**
 * The names of the category and sub category of a device.
 * @param {{categoryId: number|null, subcategoryId: number|null}} device Device
 * @param {{id: number, name: string, subcategories: {id: number, name: string}[]}[]} categories Categories
 * @returns {{category: string, subcategory: string}} The names, or empty text
 */
export function categoryNames(device, categories) {
    const category = categories.find((c) => c.id === device.categoryId);
    const sub = category ? category.subcategories.find((s) => s.id === device.subcategoryId) : null;
    return { category: category ? category.name : "", subcategory: sub ? sub.name : "" };
}
