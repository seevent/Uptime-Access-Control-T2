<template>
    <ol class="rank-list">
        <li v-for="(row, index) in rows" :key="row.id" class="rank-row">
            <span class="rank-number">{{ index + 1 }}</span>
            <input
                v-if="selectable"
                class="form-check-input rank-check"
                type="checkbox"
                :checked="isSelected(row.id)"
                :disabled="!isSelected(row.id) && selectedIds.length >= maxSelected"
                :aria-label="$t('networkHistoryRankSelect', { name: row.label })"
                :title="
                    !isSelected(row.id) && selectedIds.length >= maxSelected
                        ? $t('networkHistoryRankMax', { max: maxSelected })
                        : $t('networkHistoryRankSelect', { name: row.label })
                "
                @change="toggle(row.id)"
            />
            <div class="rank-main">
                <div class="rank-top">
                    <button
                        type="button"
                        class="btn btn-link rank-name"
                        :title="$t('networkHistoryRankOpen', { name: row.label })"
                        @click="$emit('open', row.id)"
                    >
                        {{ row.label }}
                    </button>
                    <span class="rank-value" :title="levelText(row.level)">
                        {{ row.valueText }}
                        <span v-if="row.level" class="visually-hidden">({{ levelText(row.level) }})</span>
                    </span>
                </div>
                <div class="rank-track" aria-hidden="true">
                    <div
                        class="rank-bar"
                        :class="row.level ? `level-${row.level}` : ''"
                        :style="{ width: barWidth(row.fraction) }"
                    ></div>
                </div>
            </div>
        </li>
    </ol>
</template>

<script lang="js">
export default {
    props: {
        /** Rows, best first: {id, label, valueText, fraction 0..1, level?} */
        rows: {
            type: Array,
            default: () => [],
        },
        /** Show a checkbox before every name, to pick devices */
        selectable: {
            type: Boolean,
            default: false,
        },
        selectedIds: {
            type: Array,
            default: () => [],
        },
        maxSelected: {
            type: Number,
            default: 5,
        },
    },
    emits: ["open", "update:selectedIds"],
    methods: {
        isSelected(id) {
            return this.selectedIds.includes(id);
        },

        toggle(id) {
            if (this.isSelected(id)) {
                this.$emit(
                    "update:selectedIds",
                    this.selectedIds.filter((x) => x !== id)
                );
            } else if (this.selectedIds.length < this.maxSelected) {
                this.$emit("update:selectedIds", [...this.selectedIds, id]);
            }
        },

        /**
         * Width of a bar; a bar with something in it is never thinner than 2%
         * @param {number} fraction Share of the largest value, 0 to 1
         * @returns {string} CSS width
         */
        barWidth(fraction) {
            const f = Math.max(0, Math.min(1, Number(fraction) || 0));
            return f > 0 ? `${Math.max(2, f * 100)}%` : "0";
        },

        levelText(level) {
            if (level === "good") {
                return this.$t("networkPingLevelGood");
            }
            if (level === "fair") {
                return this.$t("networkPingLevelFair");
            }
            if (level === "slow") {
                return this.$t("networkPingLevelSlow");
            }
            return "";
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.rank-list {
    list-style: none;
    margin: 0;
    padding: 0;
}

.rank-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
}

.rank-number {
    flex: 0 0 1.5rem;
    text-align: right;
    color: $secondary-text;
    font-variant-numeric: tabular-nums;
}

.rank-check {
    flex: 0 0 auto;
    margin-top: 0;
}

.rank-main {
    flex: 1 1 auto;
    min-width: 0;
}

.rank-top {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
}

.rank-name {
    padding: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    color: inherit;
    text-decoration: none;

    &:hover {
        text-decoration: underline;
    }
}

.rank-value {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
}

.rank-track {
    height: 6px;
    border-radius: 3px;
    background: rgba(128, 128, 128, 0.18);
    overflow: hidden;
}

.rank-bar {
    height: 100%;
    border-radius: 3px;
    background: #2a78d6;

    &.level-good {
        background: #0ca30c;
    }

    &.level-fair {
        background: #fab219;
    }

    &.level-slow {
        background: #d03b3b;
    }
}

.dark .rank-bar:not(.level-good, .level-fair, .level-slow) {
    background: #3987e5;
}
</style>
