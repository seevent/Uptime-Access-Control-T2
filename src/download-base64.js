/** Media type of an .xlsx file. */
export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Save data that the server sent as base64 as a file in the browser.
 * @param {string} base64 File content
 * @param {string} filename Name of the file
 * @param {string} type Media type
 * @returns {void}
 */
export function saveBase64File(base64, filename, type = XLSX_TYPE) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
