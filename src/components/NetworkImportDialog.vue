<template>
    <div ref="modal" class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-xl modal-dialog-scrollable">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">{{ $t("networkImportTitle") }}</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                </div>

                <div class="modal-body">
                    <!-- Result of the import -->
                    <template v-if="result">
                        <div
                            class="alert mb-3"
                            :class="failedMonitors.length ? 'alert-warning' : 'alert-success'"
                            role="status"
                        >
                            {{
                                $t("networkImportResult", {
                                    created: result.created,
                                    updated: result.updated,
                                    categories: result.categoriesCreated,
                                    added: result.monitorsAdded,
                                    skipped: result.monitorsSkipped,
                                    failed: failedMonitors.length,
                                })
                            }}
                            <div v-if="errorRowCount > 0" class="mt-2">
                                {{ $t("networkImportResultRowErrors", { count: errorRowCount }) }}
                            </div>
                            <template v-if="failedMonitors.length">
                                <div class="mt-2">{{ $t("networkImportFailedList") }}</div>
                                <ul class="mb-0">
                                    <li v-for="row in failedMonitors" :key="row.row">
                                        {{ $t("networkImportColumnRow") }} {{ row.row }} ({{ row.ip }}): {{ row.msg }}
                                    </li>
                                </ul>
                            </template>
                        </div>
                    </template>

                    <template v-else>
                        <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
                            <input
                                ref="file"
                                type="file"
                                accept=".xlsx"
                                class="form-control form-control-sm file-input"
                                :aria-label="$t('networkImportFile')"
                                @change="onFile"
                            />
                            <span v-if="fileName" class="small text-muted">
                                {{ $t("networkImportFileInfo", { name: fileName, count: items.length }) }}
                            </span>
                            <button type="button" class="btn btn-sm btn-normal ms-auto" @click="downloadTemplate">
                                {{ $t("networkImportTemplate") }}
                            </button>
                        </div>
                        <p class="small text-muted mb-3">{{ $t("networkImportHelp") }}</p>

                        <div v-if="parseError" class="alert alert-danger" role="alert">{{ parseError }}</div>

                        <template v-if="items.length > 0">
                            <div class="row g-3 mb-3">
                                <div class="col-md-3">
                                    <label for="networkImportType" class="form-label">
                                        {{ $t("networkImportDefaultType") }}
                                    </label>
                                    <select id="networkImportType" v-model="form.type" class="form-select">
                                        <option value="ping">{{ $t("networkScanTypePing") }}</option>
                                        <option value="port">{{ $t("networkScanTypePort") }}</option>
                                    </select>
                                </div>
                                <div class="col-md-3">
                                    <label for="networkImportPort" class="form-label">
                                        {{ $t("networkImportDefaultPort") }}
                                    </label>
                                    <input
                                        id="networkImportPort"
                                        v-model="form.port"
                                        type="number"
                                        min="1"
                                        max="65535"
                                        class="form-control"
                                    />
                                </div>
                                <div class="col-md-3">
                                    <label for="networkImportInterval" class="form-label">
                                        {{ $t("networkScanInterval") }}
                                    </label>
                                    <input
                                        id="networkImportInterval"
                                        v-model.number="form.interval"
                                        type="number"
                                        min="20"
                                        step="1"
                                        class="form-control"
                                    />
                                </div>
                                <div class="col-md-3">
                                    <label for="networkImportGroup" class="form-label">
                                        {{ $t("Monitor Group") }}
                                    </label>
                                    <select
                                        id="networkImportGroup"
                                        v-model="form.parent"
                                        class="form-select"
                                        aria-describedby="networkImportGroupHint"
                                    >
                                        <option :value="null">{{ $t("None") }}</option>
                                        <option v-for="group in groupList" :key="group.id" :value="group.id">
                                            {{ group.pathName || group.name }}
                                        </option>
                                    </select>
                                    <div id="networkImportGroupHint" class="form-text">
                                        {{ $t("networkScanGroupHint") }}
                                    </div>
                                </div>
                            </div>

                            <div class="mb-3">
                                <div class="form-label">{{ $t("Notifications") }}</div>
                                <p v-if="$root.notificationList.length === 0" class="mb-0">
                                    {{ $t("Not available, please setup.") }}
                                </p>
                                <div class="d-flex flex-wrap gap-3">
                                    <div
                                        v-for="notification in $root.notificationList"
                                        :key="notification.id"
                                        class="form-check form-switch"
                                    >
                                        <input
                                            :id="'networkImportNotification' + notification.id"
                                            v-model="form.notificationIDList[notification.id]"
                                            class="form-check-input"
                                            type="checkbox"
                                        />
                                        <label
                                            class="form-check-label"
                                            :for="'networkImportNotification' + notification.id"
                                        >
                                            {{ notification.name }}
                                        </label>
                                    </div>
                                </div>
                            </div>

                            <div v-if="previewError" class="alert alert-danger" role="alert">{{ previewError }}</div>
                            <p v-else-if="loading && !preview" class="text-center my-3">
                                {{ $t("networkImportLoadingPreview") }}
                            </p>

                            <template v-if="preview">
                                <div class="alert alert-info py-2 small" role="status">
                                    {{
                                        $t("networkImportSummary", {
                                            valid: preview.counts.new + preview.counts.update,
                                            new: preview.counts.new,
                                            update: preview.counts.update,
                                            error: preview.counts.error,
                                        })
                                    }}
                                </div>
                                <div class="table-responsive preview-box">
                                    <table class="table table-sm align-middle">
                                        <thead>
                                            <tr>
                                                <th scope="col">{{ $t("networkImportColumnRow") }}</th>
                                                <th scope="col">{{ $t("networkScanColumnIp") }}</th>
                                                <th scope="col">{{ $t("networkScanColumnLabel") }}</th>
                                                <th scope="col">{{ $t("networkScanColumnCategory") }}</th>
                                                <th scope="col">{{ $t("networkScanColumnSubcategory") }}</th>
                                                <th scope="col">{{ $t("networkScanMonitorType") }}</th>
                                                <th scope="col">{{ $t("Status") }}</th>
                                                <th scope="col">{{ $t("networkImportColumnNote") }}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr
                                                v-for="row in preview.rows"
                                                :key="row.row"
                                                :class="{ 'table-danger': row.status === 'error' }"
                                            >
                                                <td>{{ row.row }}</td>
                                                <td class="text-nowrap">{{ row.ip }}</td>
                                                <td>{{ row.name }}</td>
                                                <td>{{ row.category }}</td>
                                                <td>{{ row.subcategory }}</td>
                                                <td class="text-nowrap">{{ typeText(row) }}</td>
                                                <td>
                                                    <span class="badge" :class="statusClass(row)">
                                                        {{ statusText(row) }}
                                                    </span>
                                                </td>
                                                <td class="small">{{ noteText(row) }}</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </template>
                        </template>
                    </template>
                </div>

                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        {{ $t("Close") }}
                    </button>
                    <button v-if="result" type="button" class="btn btn-normal" @click="reset">
                        {{ $t("networkImportAnother") }}
                    </button>
                    <button
                        v-else
                        type="button"
                        class="btn btn-primary"
                        :disabled="importing || !canImport"
                        @click="submit"
                    >
                        <font-awesome-icon icon="upload" />
                        {{
                            importing ? $t("networkImportImporting") : $t("networkImportConfirm", { count: validCount })
                        }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import { MAX_IMPORT_ROWS, buildImportTemplateCsv, parseImportRows } from "../network-import-parse.js";

/** Wait this long after the last change before the rows are checked again. */
const PREVIEW_DELAY_MS = 250;

export default {
    props: {
        /** Monitor groups to choose from, as in the "add to monitoring" dialog */
        groupList: {
            type: Array,
            default: () => [],
        },
        /** Categories of the inventory, to tell which ones the import would create */
        categories: {
            type: Array,
            default: () => [],
        },
    },

    data() {
        return {
            modal: null,
            fileName: "",
            items: [],
            parseError: null,
            form: this.newForm(),
            preview: null,
            previewError: null,
            loading: false,
            importing: false,
            result: null,
            seq: 0,
            timer: null,
        };
    },

    computed: {
        validCount() {
            return this.preview ? this.preview.counts.new + this.preview.counts.update : 0;
        },

        canImport() {
            return this.validCount > 0 && !this.previewError && !this.loading;
        },

        failedMonitors() {
            return this.result ? this.result.rows.filter((row) => row.monitor === "failed") : [];
        },

        errorRowCount() {
            return this.result ? this.result.rows.filter((row) => row.status === "error").length : 0;
        },
    },

    watch: {
        form: {
            deep: true,
            handler() {
                if (this.items.length > 0 && !this.result) {
                    this.schedulePreview();
                }
            },
        },
    },

    mounted() {
        this.modal = new Modal(this.$refs.modal);
    },

    beforeUnmount() {
        clearTimeout(this.timer);
        if (this.modal) {
            try {
                this.modal.hide();
            } catch (e) {
                console.warn("Modal hide failed:", e);
            }
        }
    },

    methods: {
        /**
         * Settings for the whole import, with the notifications that are on by default.
         * @returns {object} Form values
         */
        newForm() {
            const notificationIDList = {};
            for (const notification of this.$root.notificationList || []) {
                if (notification.isDefault === true) {
                    notificationIDList[notification.id] = true;
                }
            }
            return { type: "ping", port: "", interval: 60, parent: null, notificationIDList };
        },

        /**
         * Open the dialog with nothing chosen.
         * @returns {void}
         */
        show() {
            this.reset();
            this.modal.show();
        },

        /**
         * Forget the file, the preview and the result.
         * @returns {void}
         */
        reset() {
            clearTimeout(this.timer);
            this.seq++;
            this.fileName = "";
            this.items = [];
            this.parseError = null;
            this.form = this.newForm();
            this.preview = null;
            this.previewError = null;
            this.loading = false;
            this.importing = false;
            this.result = null;
            if (this.$refs.file) {
                this.$refs.file.value = "";
            }
        },

        /**
         * Read the chosen file and show what an import would do.
         * @param {Event} event Change event of the file input
         * @returns {Promise<void>}
         */
        async onFile(event) {
            const file = event.target.files && event.target.files[0];
            this.items = [];
            this.preview = null;
            this.previewError = null;
            this.parseError = null;
            this.fileName = "";
            if (!file) {
                return;
            }

            let grid;
            try {
                const { readSheet } = await import("read-excel-file/browser");
                grid = await readSheet(file);
            } catch (e) {
                console.warn("Could not read the import file:", e);
                this.parseError = this.$t("networkImportErrorRead");
                return;
            }

            const { items, error } = parseImportRows(grid);
            if (error) {
                this.parseError = this.errorText(error);
                return;
            }
            this.fileName = file.name;
            this.items = items;
            this.schedulePreview();
        },

        /**
         * @param {{code: string, count?: number}} error Error of the parser
         * @returns {string} Text for the user
         */
        errorText(error) {
            if (error.code === "no-ip-column") {
                return this.$t("networkImportErrorNoIp");
            }
            if (error.code === "too-many-rows") {
                return this.$t("networkImportErrorTooMany", { count: error.count, max: MAX_IMPORT_ROWS });
            }
            return this.$t("networkImportErrorEmpty");
        },

        /**
         * Settings as the server wants them.
         * @returns {object} Options of importNetworkDevices
         */
        options() {
            return {
                type: this.form.type,
                port: this.form.port,
                interval: this.form.interval,
                parent: this.form.parent,
                notificationIDList: this.form.notificationIDList,
            };
        },

        /**
         * Check the rows again shortly after the last change.
         * @returns {void}
         */
        schedulePreview() {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.loadPreview(), PREVIEW_DELAY_MS);
        },

        /**
         * Ask the server what an import would do. Only the newest answer is used.
         * @returns {void}
         */
        loadPreview() {
            const seq = ++this.seq;
            this.loading = true;
            const payload = { rows: this.items, options: this.options(), dryRun: true };
            this.$root.getSocket().emit("importNetworkDevices", payload, (res) => {
                if (seq !== this.seq) {
                    return;
                }
                this.loading = false;
                if (res.ok) {
                    this.preview = { rows: res.rows, counts: res.counts };
                    this.previewError = null;
                } else {
                    this.preview = null;
                    this.previewError = res.msg;
                }
            });
        },

        /**
         * Import the valid rows.
         * @returns {void}
         */
        submit() {
            this.importing = true;
            const payload = { rows: this.items, options: this.options(), dryRun: false };
            this.$root.getSocket().emit("importNetworkDevices", payload, (res) => {
                this.importing = false;
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.result = res;
            });
        },

        /**
         * Download the template file.
         * @returns {void}
         */
        downloadTemplate() {
            const blob = new Blob([buildImportTemplateCsv()], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "template-impor-device.csv";
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        },

        /**
         * @param {object} row Row of the preview
         * @returns {string} Monitor type, with the port for a port monitor
         */
        typeText(row) {
            if (row.status === "error") {
                return row.type;
            }
            return row.type === "port"
                ? `${this.$t("networkScanTypePort")} ${row.port}`
                : this.$t("networkScanTypePing");
        },

        /**
         * @param {object} row Row of the preview
         * @returns {string} Text of the status badge
         */
        statusText(row) {
            if (row.status === "error") {
                return this.$t("networkImportStatusError");
            }
            if (row.action === "has-monitor") {
                return this.$t("networkImportStatusMonitored");
            }
            return row.status === "new" ? this.$t("networkImportStatusNew") : this.$t("networkImportStatusUpdated");
        },

        /**
         * @param {object} row Row of the preview
         * @returns {string} Bootstrap classes of the status badge
         */
        statusClass(row) {
            if (row.status === "error") {
                return "bg-danger";
            }
            if (row.action === "has-monitor") {
                return "bg-secondary";
            }
            return row.status === "new" ? "bg-success" : "bg-primary";
        },

        /**
         * @param {object} row Row of the preview
         * @returns {string} What the import does with the row, or why it is skipped
         */
        noteText(row) {
            if (row.status === "error") {
                return row.msg;
            }
            const notes = [
                row.action === "has-monitor"
                    ? this.$t("networkImportNoteHasMonitor")
                    : this.$t("networkImportNoteAddMonitor"),
            ];
            if (row.category !== "" && !this.categoryExists(row.category)) {
                notes.push(this.$t("networkImportNoteNewCategory", { name: row.category }));
            }
            return notes.join("; ");
        },

        /**
         * @param {string} name Category name from the file
         * @returns {boolean} True when the inventory already has a category with that name (ignoring case)
         */
        categoryExists(name) {
            const wanted = name.toLowerCase();
            return this.categories.some((category) => category.name.toLowerCase() === wanted);
        },
    },
};
</script>

<style lang="scss" scoped>
.file-input {
    max-width: 340px;
}

.preview-box {
    max-height: 45vh;
    overflow: auto;
}
</style>
