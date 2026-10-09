/*
 * Download the IEEE OUI registry and write it to server/data/oui.json.
 * The Network Scan page uses that file to show the vendor of a MAC address.
 *
 * Usage: node extra/update-oui.js
 */
const fs = require("node:fs");
const path = require("node:path");

const OUI_URL = "https://standards-oui.ieee.org/oui/oui.csv";
const OUTPUT_PATH = path.join(__dirname, "..", "server", "data", "oui.json");

/**
 * Split one CSV line into fields, honoring double quotes.
 * @param {string} line One CSV line
 * @returns {string[]} Fields
 */
function splitCsvLine(line) {
    const fields = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (quoted) {
            if (char === '"' && line[i + 1] === '"') {
                current += '"';
                i++;
            } else if (char === '"') {
                quoted = false;
            } else {
                current += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ",") {
            fields.push(current);
            current = "";
        } else {
            current += char;
        }
    }
    fields.push(current);
    return fields;
}

/**
 * Parse the IEEE oui.csv content into a prefix to vendor map.
 * @param {string} csv Content of oui.csv (columns: Registry, Assignment, Organization Name, Organization Address)
 * @returns {Record<string, string>} Map of 6 digit upper case hex prefix to organization name
 */
function parseOuiCsv(csv) {
    const table = {};
    for (const line of csv.split(/\r?\n/).slice(1)) {
        if (line.trim() === "") {
            continue;
        }
        const [, assignment, name] = splitCsvLine(line);
        if (/^[0-9A-Fa-f]{6}$/.test(assignment ?? "") && name) {
            table[assignment.toUpperCase()] = name.trim();
        }
    }
    return table;
}

/**
 * Download the registry and write server/data/oui.json.
 * @returns {Promise<void>}
 */
async function main() {
    const response = await fetch(OUI_URL);
    if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
    }
    const table = parseOuiCsv(await response.text());
    const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(sorted));
    console.log(`Wrote ${Object.keys(sorted).length} vendors to ${OUTPUT_PATH}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Could not update the OUI table: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { parseOuiCsv };
