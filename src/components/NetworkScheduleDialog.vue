<template>
    <div ref="modal" class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-dialog-scrollable">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">{{ $t("networkScheduleTitle") }}</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                </div>

                <div class="modal-body">
                    <p class="form-text mt-0">{{ $t("networkScheduleHelp") }}</p>

                    <div class="form-check form-switch mb-3">
                        <input
                            id="networkScheduleEnabled"
                            v-model="form.enabled"
                            class="form-check-input"
                            type="checkbox"
                        />
                        <label class="form-check-label" for="networkScheduleEnabled">
                            {{ $t("networkScheduleEnable") }}
                        </label>
                    </div>

                    <div class="mb-3">
                        <label for="networkScheduleInterval" class="form-label">
                            {{ $t("networkScheduleInterval") }}
                        </label>
                        <input
                            id="networkScheduleInterval"
                            v-model.number="form.intervalMinutes"
                            type="number"
                            class="form-control w-auto"
                            min="5"
                            max="1440"
                            step="1"
                        />
                    </div>

                    <div class="mb-3">
                        <label for="networkScheduleRanges" class="form-label">{{ $t("networkScheduleRanges") }}</label>
                        <textarea
                            id="networkScheduleRanges"
                            v-model="rangesText"
                            class="form-control ranges-input"
                            rows="3"
                            spellcheck="false"
                            placeholder="192.168.1.0/24"
                        ></textarea>
                        <button
                            v-if="suggestedRanges.trim() !== ''"
                            type="button"
                            class="btn btn-sm btn-normal mt-1"
                            @click="rangesText = suggestedRanges"
                        >
                            {{ $t("networkScheduleUseCurrent") }}
                        </button>
                    </div>

                    <div class="mb-1">
                        <div class="form-label">{{ $t("networkScheduleNotifications") }}</div>
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
                                    :id="'networkScheduleNotification' + notification.id"
                                    v-model="chosen[notification.id]"
                                    class="form-check-input"
                                    type="checkbox"
                                />
                                <label class="form-check-label" :for="'networkScheduleNotification' + notification.id">
                                    {{ notification.name }}
                                </label>
                            </div>
                        </div>
                        <div class="form-text">{{ $t("networkScheduleNotificationsHelp") }}</div>
                    </div>

                    <div v-if="nextRunText" class="alert alert-info mt-3 mb-0" role="status">
                        {{ $t("networkScheduleNext", { time: nextRunText }) }}
                    </div>
                </div>

                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        {{ $t("Close") }}
                    </button>
                    <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
                        {{ $t("networkScheduleSave") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";

export default {
    props: {
        /** The ranges typed in the scan form, offered as a shortcut */
        suggestedRanges: {
            type: String,
            default: "",
        },
    },

    data() {
        return {
            modal: null,
            saving: false,
            form: { enabled: false, intervalMinutes: 60 },
            rangesText: "",
            chosen: {},
            nextRunAt: null,
        };
    },

    computed: {
        nextRunText() {
            if (!this.form.enabled || this.nextRunAt === null) {
                return "";
            }
            return this.$root.datetimeFormat(new Date(this.nextRunAt).toISOString(), "YYYY-MM-DD HH:mm");
        },
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
         * Load the stored schedule and open the dialog.
         * @returns {void}
         */
        show() {
            this.$root.getSocket().emit("getNetworkScanSchedule", (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.apply(res);
                this.modal.show();
            });
        },

        /**
         * Fill the form with a schedule from the server.
         * @param {{schedule: object, nextRunAt: ?number}} res Reply of the server
         * @returns {void}
         */
        apply(res) {
            const schedule = res.schedule;
            this.form = { enabled: schedule.enabled, intervalMinutes: schedule.intervalMinutes };
            this.rangesText = schedule.ranges.join("\n");
            this.chosen = Object.fromEntries(schedule.notificationIDList.map((id) => [id, true]));
            this.nextRunAt = res.nextRunAt;
        },

        /**
         * Store the schedule.
         * @returns {void}
         */
        save() {
            this.saving = true;
            const payload = {
                enabled: this.form.enabled,
                intervalMinutes: this.form.intervalMinutes,
                ranges: this.rangesText.split(/\r?\n/),
                notificationIDList: Object.keys(this.chosen)
                    .filter((id) => this.chosen[id])
                    .map(Number),
            };
            this.$root.getSocket().emit("saveNetworkScanSchedule", payload, (res) => {
                this.saving = false;
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.apply(res);
                this.$root.toastSuccess(this.$t("networkScheduleSaved"));
            });
        },
    },
};
</script>

<style lang="scss" scoped>
.ranges-input {
    font-family: monospace;
}
</style>
