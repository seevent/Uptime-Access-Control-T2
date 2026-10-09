<template>
    <div class="period-picker d-flex flex-wrap align-items-center gap-2">
        <div class="btn-group btn-group-sm" role="group" :aria-label="$t('networkUptimePeriod')">
            <button
                v-for="preset in presets"
                :key="preset"
                type="button"
                class="btn"
                :class="modelValue.preset === preset ? 'btn-primary' : 'btn-outline-primary'"
                @click="choosePreset(preset)"
            >
                {{ $t("networkUptimePreset" + preset) }}
            </button>
            <button
                type="button"
                class="btn"
                :class="modelValue.preset === 'custom' ? 'btn-primary' : 'btn-outline-primary'"
                :aria-expanded="showCustom"
                @click="toggleCustom"
            >
                {{ $t("networkUptimeCustom") }}
            </button>
        </div>

        <form v-if="showCustom" class="d-flex flex-wrap align-items-center gap-2" @submit.prevent="applyCustom">
            <label class="d-flex align-items-center gap-1 mb-0">
                <span class="small">{{ $t("networkUptimeCustomFrom") }}</span>
                <input v-model="customFrom" type="datetime-local" class="form-control form-control-sm" required />
            </label>
            <label class="d-flex align-items-center gap-1 mb-0">
                <span class="small">{{ $t("networkUptimeCustomTo") }}</span>
                <input v-model="customTo" type="datetime-local" class="form-control form-control-sm" required />
            </label>
            <button type="submit" class="btn btn-sm btn-primary" :disabled="!customValid">
                {{ $t("networkUptimeApply") }}
            </button>
        </form>
    </div>
</template>

<script>
const PRESET_NAMES = ["1h", "24h", "7d", "30d"];

export default {
    props: {
        /** The chosen period: `{ preset: "1h"|"24h"|"7d"|"30d"|"custom", from?: string, to?: string }` */
        modelValue: {
            type: Object,
            required: true,
        },
    },

    emits: ["update:modelValue"],

    data() {
        return {
            presets: PRESET_NAMES,
            showCustom: this.modelValue.preset === "custom",
            customFrom: "",
            customTo: "",
        };
    },

    computed: {
        /**
         * Both times are filled in and the start is before the end (same fixed-width format, so text order works).
         * @returns {boolean} True when the range can be applied
         */
        customValid() {
            return this.customFrom !== "" && this.customTo !== "" && this.customFrom < this.customTo;
        },
    },

    methods: {
        /**
         * Pick one of the ready-made periods.
         * @param {string} preset Preset name
         * @returns {void}
         */
        choosePreset(preset) {
            this.showCustom = false;
            this.$emit("update:modelValue", { preset });
        },

        /**
         * Show or hide the custom range inputs, filled with the last 24 hours the first time.
         * @returns {void}
         */
        toggleCustom() {
            this.showCustom = !this.showCustom;
            if (this.showCustom && this.customFrom === "") {
                const now = Date.now();
                this.customFrom = this.$root.toDateTimeInputFormat(now - 86400000);
                this.customTo = this.$root.toDateTimeInputFormat(now);
            }
        },

        /**
         * Use the typed range. The inputs are in the time zone chosen in the settings.
         * @returns {void}
         */
        applyCustom() {
            if (!this.customValid) {
                return;
            }
            this.$emit("update:modelValue", {
                preset: "custom",
                from: this.$root.toUTC(this.customFrom),
                to: this.$root.toUTC(this.customTo),
            });
        },
    },
};
</script>

<style lang="scss" scoped>
.period-picker input[type="datetime-local"] {
    width: auto;
}
</style>
