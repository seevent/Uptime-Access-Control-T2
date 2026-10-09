<template>
    <div ref="modal" class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-dialog-scrollable">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">{{ $t("networkReportTitle") }}</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                </div>

                <div class="modal-body">
                    <p class="form-text mt-0">{{ $t("networkReportHelp") }}</p>

                    <div class="mb-3">
                        <label for="networkReportMonth" class="form-label">{{ $t("networkReportMonth") }}</label>
                        <div class="d-flex flex-wrap gap-2 align-items-center">
                            <input
                                id="networkReportMonth"
                                v-model="month"
                                type="month"
                                class="form-control w-auto"
                                :max="currentMonth"
                            />
                            <button type="button" class="btn btn-primary" :disabled="busy || !month" @click="download">
                                <font-awesome-icon icon="file-excel" />
                                {{ $t("networkReportDownload") }}
                            </button>
                            <button type="button" class="btn btn-normal" :disabled="busy || !month" @click="saveNow">
                                {{ $t("networkReportSaveNow") }}
                            </button>
                        </div>
                        <div class="form-text">{{ $t("networkReportPartialHint") }}</div>
                    </div>

                    <hr />

                    <h6>{{ $t("networkReportAutoTitle") }}</h6>
                    <div class="form-check form-switch mb-3">
                        <input
                            id="networkReportEnabled"
                            v-model="form.enabled"
                            class="form-check-input"
                            type="checkbox"
                        />
                        <label class="form-check-label" for="networkReportEnabled">
                            {{ $t("networkReportAutoEnable") }}
                        </label>
                    </div>

                    <div class="mb-3">
                        <label for="networkReportHour" class="form-label">{{ $t("networkReportHour") }}</label>
                        <input
                            id="networkReportHour"
                            v-model.number="form.hour"
                            type="number"
                            class="form-control w-auto"
                            min="0"
                            max="23"
                            step="1"
                        />
                    </div>

                    <div class="mb-1">
                        <label for="networkReportFolder" class="form-label">{{ $t("networkReportFolder") }}</label>
                        <input
                            id="networkReportFolder"
                            v-model="form.folder"
                            type="text"
                            class="form-control folder-input"
                            maxlength="500"
                            spellcheck="false"
                            :placeholder="defaultFolder"
                        />
                        <div class="form-text">{{ $t("networkReportFolderHelp", { folder: effectiveFolder }) }}</div>
                    </div>
                </div>

                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        {{ $t("Close") }}
                    </button>
                    <button type="button" class="btn btn-primary" :disabled="busy" @click="save">
                        {{ $t("networkReportSave") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import { saveBase64File } from "../download-base64.js";

export default {
    data() {
        return {
            modal: null,
            busy: false,
            month: "",
            currentMonth: "",
            form: { enabled: false, hour: 7, folder: "" },
            defaultFolder: "",
            effectiveFolder: "",
        };
    },

    mounted() {
        this.modal = new Modal(this.$refs.modal);
    },

    beforeUnmount() {
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
         * Load the settings and open the dialog, with last month chosen.
         * @returns {void}
         */
        show() {
            this.$root.getSocket().emit("getNetworkReportSettings", (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.apply(res);
                this.month = res.lastMonth;
                const now = new Date();
                this.currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
                this.modal.show();
            });
        },

        /**
         * Fill the form with the settings from the server.
         * @param {{settings: object, folder: string}} res Reply of the server
         * @returns {void}
         */
        apply(res) {
            this.form = { enabled: res.settings.enabled, hour: res.settings.hour, folder: res.settings.folder };
            this.effectiveFolder = res.folder;
            if (res.settings.folder === "") {
                this.defaultFolder = res.folder;
            }
        },

        /**
         * Store the settings of the automatic report.
         * @returns {void}
         */
        save() {
            this.busy = true;
            this.$root.getSocket().emit("saveNetworkReportSettings", { ...this.form }, (res) => {
                this.busy = false;
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.apply(res);
                this.$root.toastSuccess(this.$t("networkReportSaved"));
            });
        },

        /**
         * Make the report of the chosen month and save it as a file in the browser.
         * @returns {void}
         */
        download() {
            this.busy = true;
            this.$root.getSocket().emit("downloadNetworkReport", { month: this.month }, (res) => {
                this.busy = false;
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                saveBase64File(res.data, res.filename);
            });
        },

        /**
         * Make the report of the chosen month and save it in the folder of the server.
         * @returns {void}
         */
        saveNow() {
            this.busy = true;
            this.$root.getSocket().emit("saveNetworkReportNow", { month: this.month }, (res) => {
                this.busy = false;
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.$root.toastSuccess(this.$t("networkReportSavedAt", { file: res.file }));
            });
        },
    },
};
</script>

<style lang="scss" scoped>
.folder-input {
    font-family: monospace;
}
</style>
