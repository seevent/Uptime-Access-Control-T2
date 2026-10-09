<template>
    <div>
        <div v-if="loaded && !supported" class="alert alert-warning my-4" role="alert">
            {{ $t("databaseBackupUnsupported") }}
        </div>

        <template v-else>
            <p class="form-text my-3">{{ $t("databaseBackupHelp") }}</p>

            <div class="form-check form-switch my-3">
                <input id="databaseBackupEnabled" v-model="form.enabled" class="form-check-input" type="checkbox" />
                <label class="form-check-label" for="databaseBackupEnabled">{{ $t("databaseBackupEnable") }}</label>
            </div>

            <div class="row g-3 mb-3">
                <div class="col-sm-6 col-md-4">
                    <label for="databaseBackupInterval" class="form-label">{{ $t("databaseBackupInterval") }}</label>
                    <input
                        id="databaseBackupInterval"
                        v-model.number="form.intervalHours"
                        type="number"
                        class="form-control"
                        min="1"
                        max="720"
                        step="1"
                    />
                </div>
                <div class="col-sm-6 col-md-4">
                    <label for="databaseBackupKeep" class="form-label">{{ $t("databaseBackupKeep") }}</label>
                    <input
                        id="databaseBackupKeep"
                        v-model.number="form.keep"
                        type="number"
                        class="form-control"
                        min="1"
                        max="365"
                        step="1"
                    />
                </div>
            </div>

            <div class="mb-3">
                <label for="databaseBackupFolder" class="form-label">{{ $t("databaseBackupFolder") }}</label>
                <input
                    id="databaseBackupFolder"
                    v-model="form.folder"
                    type="text"
                    class="form-control folder-input"
                    maxlength="500"
                    spellcheck="false"
                    :placeholder="defaultFolder"
                />
                <div class="form-text">{{ $t("databaseBackupFolderHelp", { folder }) }}</div>
            </div>

            <div class="my-4">
                <button class="btn btn-primary me-2" type="button" :disabled="busy" @click="save">
                    {{ $t("Save") }}
                </button>
                <button class="btn btn-outline-primary" type="button" :disabled="busy" @click="runNow">
                    {{ $t("databaseBackupNow") }}
                </button>
            </div>

            <h5 class="mt-4">{{ $t("databaseBackupListTitle") }}</h5>
            <p v-if="backups.length === 0" class="text-muted">{{ $t("databaseBackupNone") }}</p>
            <div v-else class="table-responsive">
                <table class="table table-sm align-middle">
                    <thead>
                        <tr>
                            <th>{{ $t("databaseBackupFile") }}</th>
                            <th>{{ $t("databaseBackupTime") }}</th>
                            <th class="text-end">{{ $t("databaseBackupSize") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="item in backups" :key="item.name">
                            <td class="folder-input">{{ item.name }}</td>
                            <td>{{ $root.datetime(new Date(item.time).toISOString()) }}</td>
                            <td class="text-end">{{ formatSize(item.size) }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div class="alert alert-info mt-4" role="note">
                <strong>{{ $t("databaseBackupRestoreTitle") }}</strong>
                <div>{{ $t("databaseBackupRestoreHelp") }}</div>
            </div>
        </template>
    </div>
</template>

<script>
export default {
    data() {
        return {
            loaded: false,
            supported: true,
            busy: false,
            form: { enabled: false, folder: "", intervalHours: 24, keep: 14 },
            folder: "",
            defaultFolder: "",
            backups: [],
        };
    },

    mounted() {
        this.$root.getSocket().emit("getDatabaseBackup", (res) => {
            if (res.ok) {
                this.apply(res);
            } else {
                this.$root.toastRes(res);
            }
            this.loaded = true;
        });
    },

    methods: {
        /**
         * Fill the page with a reply of the server.
         * @param {{settings: object, folder: string, supported: boolean, backups: object[]}} res Reply
         * @returns {void}
         */
        apply(res) {
            this.form = { ...res.settings };
            this.folder = res.folder;
            if (res.settings.folder === "") {
                this.defaultFolder = res.folder;
            }
            this.supported = res.supported;
            this.backups = res.backups;
        },

        /**
         * Store the settings.
         * @returns {void}
         */
        save() {
            this.busy = true;
            this.$root.getSocket().emit("saveDatabaseBackup", { ...this.form }, (res) => {
                this.busy = false;
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.apply(res);
                this.$root.toastSuccess(this.$t("databaseBackupSaved"));
            });
        },

        /**
         * Make a backup now, in the folder.
         * @returns {void}
         */
        runNow() {
            this.busy = true;
            this.$root.getSocket().emit("runDatabaseBackup", (res) => {
                this.busy = false;
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.backups = res.backups;
                this.$root.toastSuccess(this.$t("databaseBackupMade", { file: res.file }));
            });
        },

        /**
         * @param {number} bytes Size in bytes
         * @returns {string} For example "12.3 MB"
         */
        formatSize(bytes) {
            const units = ["B", "KB", "MB", "GB"];
            let value = bytes;
            let unit = 0;
            while (value >= 1024 && unit < units.length - 1) {
                value /= 1024;
                unit++;
            }
            return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
        },
    },
};
</script>

<style lang="scss" scoped>
.folder-input {
    font-family: monospace;
}
</style>
