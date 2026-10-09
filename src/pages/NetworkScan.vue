<template>
    <transition name="slide-fade" appear>
        <div>
            <h1 class="mb-2">
                {{ $t("networkScan") }}
            </h1>

            <div class="shadow-box big-padding mb-2">
                <form @submit.prevent="startScan">
                    <label for="networkScanRanges" class="form-label">{{ $t("networkScanRanges") }}</label>
                    <textarea
                        id="networkScanRanges"
                        v-model="rangesText"
                        class="form-control ranges-input"
                        rows="2"
                        spellcheck="false"
                        :disabled="scanning"
                        placeholder="192.168.1.0/24"
                    ></textarea>
                    <div class="form-text">{{ $t("networkScanRangesHelp", { max: maxHosts }) }}</div>

                    <div class="mt-2">
                        <button v-if="!scanning" type="submit" class="btn btn-primary btn-sm" :disabled="starting">
                            <font-awesome-icon icon="network-wired" />
                            {{ $t("networkScanStart") }}
                        </button>
                        <button v-else type="button" class="btn btn-danger btn-sm" @click="cancelScan">
                            <font-awesome-icon icon="times" />
                            {{ $t("networkScanCancel") }}
                        </button>
                        <button type="button" class="btn btn-sm btn-normal ms-2" @click="openScheduleDialog">
                            <font-awesome-icon icon="clock" />
                            {{ $t("networkScheduleButton") }}
                        </button>
                    </div>
                </form>

                <div v-if="scanning" class="mt-3">
                    <div
                        class="progress"
                        role="progressbar"
                        :aria-valuenow="percent"
                        aria-valuemin="0"
                        aria-valuemax="100"
                    >
                        <div class="progress-bar" :style="{ width: percent + '%' }">{{ percent }}%</div>
                    </div>
                    <div class="form-text">
                        {{
                            $t("networkScanProgress", {
                                done: progress.done,
                                total: progress.total,
                                found: progress.found,
                            })
                        }}
                    </div>
                </div>

                <div v-if="scanError" class="alert alert-danger mt-3 mb-0" role="alert">
                    {{ $t("networkScanFailed", { msg: scanError }) }}
                </div>
                <template v-else-if="summary">
                    <div class="alert alert-info mt-3 mb-0" role="status">
                        <template v-if="summary.cancelled">
                            {{ $t("networkScanCancelled", { found: summary.found }) }}
                        </template>
                        <template v-else>
                            {{
                                $t("networkScanSummary", {
                                    found: summary.found,
                                    new: summary.new,
                                    missing: summary.missing,
                                })
                            }}
                        </template>
                    </div>
                    <div v-if="!summary.arpAvailable" class="alert alert-warning mt-2 mb-0" role="alert">
                        {{ $t("networkScanArpUnavailable") }}
                    </div>
                </template>
            </div>

            <div class="shadow-box big-padding">
                <div class="d-flex flex-wrap align-items-center justify-content-between mb-2">
                    <h2 class="mb-0">
                        {{ $t("networkScanDevices") }}
                        ({{
                            filterActive
                                ? $t("networkFilterCount", { shown: visibleDevices.length, total: devices.length })
                                : devices.length
                        }})
                    </h2>
                    <div class="d-flex flex-wrap gap-2">
                        <button type="button" class="btn btn-sm btn-normal" @click="openImportDialog">
                            <font-awesome-icon icon="upload" />
                            {{ $t("networkImportButton") }}
                        </button>
                        <button type="button" class="btn btn-sm btn-normal" @click="openCategoryDialog">
                            <font-awesome-icon icon="cog" />
                            {{ $t("networkScanManageCategories") }}
                        </button>
                        <button
                            type="button"
                            class="btn btn-sm btn-primary"
                            :disabled="selectedUnmonitored.length === 0"
                            @click="openAddDialog"
                        >
                            <font-awesome-icon icon="plus" />
                            {{ $t("networkScanAddSelected", { count: selectedUnmonitored.length }) }}
                        </button>
                    </div>
                </div>

                <div
                    v-if="unknownDevices.length > 0"
                    class="alert alert-warning d-flex flex-wrap align-items-center justify-content-between gap-2 py-2 mb-2"
                    role="alert"
                >
                    <div>
                        <strong>{{ $t("networkUnknownBanner", { count: unknownDevices.length }) }}</strong>
                        <div class="small">{{ $t("networkUnknownBannerHelp") }}</div>
                    </div>
                    <button type="button" class="btn btn-sm btn-warning" :disabled="confirming" @click="confirmAll">
                        <font-awesome-icon icon="check" />
                        {{ $t("networkUnknownConfirmAll") }}
                    </button>
                </div>

                <div v-if="devices.length > 0" class="d-flex flex-wrap align-items-center gap-2 mb-2">
                    <NetworkPeriodPicker :model-value="period" @update:model-value="onPeriodChange" />
                    <label class="visually-hidden" for="networkFilterCategory">
                        {{ $t("networkFilterCategory") }}
                    </label>
                    <select
                        id="networkFilterCategory"
                        class="form-select form-select-sm w-auto"
                        :value="categoryFilter.categoryId === null ? '' : String(categoryFilter.categoryId)"
                        @change="onFilterCategory($event.target.value)"
                    >
                        <option value="">{{ $t("networkFilterCategory") }}: {{ $t("networkFilterAll") }}</option>
                        <option v-for="category in categories" :key="category.id" :value="String(category.id)">
                            {{ category.name }}
                        </option>
                        <option value="none">{{ $t("networkFilterNone") }}</option>
                    </select>
                    <template v-if="filterCategory && filterCategory.subcategories.length > 0">
                        <label class="visually-hidden" for="networkFilterSubcategory">
                            {{ $t("networkFilterSubcategory") }}
                        </label>
                        <select
                            id="networkFilterSubcategory"
                            class="form-select form-select-sm w-auto"
                            :value="categoryFilter.subcategoryId === null ? '' : String(categoryFilter.subcategoryId)"
                            @change="onFilterSub($event.target.value)"
                        >
                            <option value="">{{ $t("networkFilterSubcategory") }}: {{ $t("networkFilterAll") }}</option>
                            <option v-for="sub in filterCategory.subcategories" :key="sub.id" :value="String(sub.id)">
                                {{ sub.name }}
                            </option>
                        </select>
                    </template>
                    <button
                        type="button"
                        class="btn btn-sm btn-normal"
                        :disabled="uptimeLoading || pingLoading"
                        @click="refreshSummaries"
                    >
                        {{ $t("networkUptimeRefresh") }}
                    </button>
                    <span
                        v-if="uptimeLoading || pingLoading"
                        class="spinner-border spinner-border-sm"
                        role="status"
                        :aria-label="$t('networkUptimeLoading')"
                    ></span>
                    <button
                        type="button"
                        class="btn btn-sm btn-normal ms-auto"
                        :disabled="!hasMonitoredDevice"
                        @click="openHistory"
                    >
                        <font-awesome-icon icon="chart-line" />
                        {{ $t("networkHistoryButton") }}
                    </button>
                    <button type="button" class="btn btn-sm btn-normal" @click="openReportDialog">
                        <font-awesome-icon icon="file-excel" />
                        {{ $t("networkReportButton") }}
                    </button>
                    <button
                        type="button"
                        class="btn btn-sm btn-normal"
                        :disabled="uptimeItems.length === 0"
                        @click="exportCsv"
                    >
                        {{ $t("networkUptimeExportCsv") }}
                    </button>
                </div>

                <div
                    v-if="selectedDevices.length > 0"
                    class="bulk-bar d-flex flex-wrap align-items-center gap-2 mb-2"
                    role="group"
                    :aria-label="$t('networkBulkSelected', { count: selectedDevices.length })"
                >
                    <strong>{{ $t("networkBulkSelected", { count: selectedDevices.length }) }}</strong>
                    <label class="visually-hidden" for="networkBulkCategory">{{ $t("networkFilterCategory") }}</label>
                    <select
                        id="networkBulkCategory"
                        v-model="bulkCategory"
                        class="form-select form-select-sm w-auto"
                        @change="bulkSub = ''"
                    >
                        <option value="">{{ $t("networkBulkPickCategory") }}</option>
                        <option value="none">{{ $t("networkBulkNoCategory") }}</option>
                        <option v-for="category in categories" :key="category.id" :value="String(category.id)">
                            {{ category.name }}
                        </option>
                    </select>
                    <label class="visually-hidden" for="networkBulkSubcategory">
                        {{ $t("networkFilterSubcategory") }}
                    </label>
                    <select
                        id="networkBulkSubcategory"
                        v-model="bulkSub"
                        class="form-select form-select-sm w-auto"
                        :disabled="!bulkCategoryObject || bulkCategoryObject.subcategories.length === 0"
                    >
                        <option value="">{{ $t("networkBulkNoSub") }}</option>
                        <option
                            v-for="sub in bulkCategoryObject ? bulkCategoryObject.subcategories : []"
                            :key="sub.id"
                            :value="String(sub.id)"
                        >
                            {{ sub.name }}
                        </option>
                    </select>
                    <button
                        type="button"
                        class="btn btn-sm btn-primary"
                        :disabled="bulkCategory === '' || bulkBusy"
                        @click="applyBulkCategory"
                    >
                        {{ $t("networkBulkApply") }}
                    </button>
                    <span class="text-muted mx-1">|</span>
                    <label class="visually-hidden" for="networkBulkParent">{{ $t("networkDependsOn") }}</label>
                    <select id="networkBulkParent" v-model="bulkParent" class="form-select form-select-sm w-auto">
                        <option value="">{{ $t("networkDependsOnPick") }}</option>
                        <option value="none">{{ $t("networkDependsOnNone") }}</option>
                        <option v-for="parent in parentChoices" :key="parent.id" :value="String(parent.id)">
                            {{ deviceName(parent) }}
                        </option>
                    </select>
                    <button
                        type="button"
                        class="btn btn-sm btn-primary"
                        :disabled="bulkParent === '' || bulkBusy"
                        @click="applyBulkDependency"
                    >
                        {{ $t("networkDependsOnApply") }}
                    </button>
                    <button type="button" class="btn btn-sm btn-normal" :disabled="bulkBusy" @click="clearSelection">
                        {{ $t("networkBulkClear") }}
                    </button>
                </div>

                <p v-if="devices.length === 0" class="text-center my-3">
                    {{ $t("networkScanNoDevices") }}
                </p>

                <p v-else-if="visibleDevices.length === 0" class="text-center my-3">
                    {{ $t("networkFilterEmpty") }}
                </p>

                <div v-else class="table-responsive">
                    <table class="table table-sm align-middle device-table">
                        <thead>
                            <tr>
                                <th scope="col">
                                    <input
                                        class="form-check-input"
                                        type="checkbox"
                                        :aria-label="$t('networkScanSelectAll')"
                                        :checked="allSelected"
                                        :disabled="selectableDevices.length === 0"
                                        @change="toggleAll($event.target.checked)"
                                    />
                                </th>
                                <th scope="col">{{ $t("networkScanColumnIp") }}</th>
                                <th scope="col">{{ $t("networkScanColumnStatus") }}</th>
                                <th scope="col">{{ $t("networkScanColumnLabel") }}</th>
                                <th scope="col">{{ $t("networkScanColumnCategory") }}</th>
                                <th scope="col">{{ $t("networkScanColumnSubcategory") }}</th>
                                <th scope="col">{{ $t("networkUptimeColumn") }}</th>
                                <th scope="col">{{ $t("networkPingColumn") }}</th>
                                <th scope="col">{{ $t("networkScanColumnHostname") }}</th>
                                <th scope="col">{{ $t("networkScanColumnMac") }}</th>
                                <th scope="col">{{ $t("networkScanColumnVendor") }}</th>
                                <th scope="col">{{ $t("networkScanColumnLastSeen") }}</th>
                                <th scope="col"></th>
                            </tr>
                        </thead>
                        <tbody>
                            <template v-for="row in tableRows" :key="row.key">
                                <tr v-if="row.kind !== 'device'" class="group-row" :class="'group-' + row.kind">
                                    <td colspan="13">
                                        <button
                                            type="button"
                                            class="group-toggle"
                                            :aria-expanded="!row.collapsed"
                                            :aria-label="$t('networkScanToggleGroup', { name: row.name })"
                                            @click="toggleGroup(row.key)"
                                        >
                                            <font-awesome-icon
                                                icon="chevron-down"
                                                class="group-chevron"
                                                :class="{ collapsed: row.collapsed }"
                                            />
                                            <span class="group-name">{{ row.name }}</span>
                                            <span class="badge bg-secondary ms-2">
                                                {{ $t("networkScanDeviceCount", { count: row.count }) }}
                                            </span>
                                        </button>
                                    </td>
                                </tr>
                                <tr v-else>
                                    <td>
                                        <input
                                            v-model="selectedIds"
                                            class="form-check-input"
                                            type="checkbox"
                                            :value="row.device.id"
                                            :aria-label="$t('networkScanSelectDevice', { ip: row.device.ip })"
                                        />
                                    </td>
                                    <td
                                        class="text-nowrap"
                                        :class="{ 'indent-1': row.depth >= 1, 'indent-2': row.depth >= 2 }"
                                    >
                                        {{ row.device.ip }}
                                    </td>
                                    <td class="text-nowrap">
                                        <span v-if="row.device.isOnline" class="badge bg-primary me-1">
                                            {{ $t("networkScanBadgeOnline") }}
                                        </span>
                                        <span v-else class="badge bg-secondary me-1">
                                            {{ $t("networkScanBadgeMissing") }}
                                        </span>
                                        <span v-if="isNewDevice(row.device)" class="badge bg-success me-1">
                                            {{ $t("networkScanBadgeNew") }}
                                        </span>
                                        <button
                                            v-if="!row.device.acknowledged"
                                            type="button"
                                            class="badge bg-danger border-0 me-1"
                                            :title="(row.device.alertNote || '') + ' — ' + $t('networkUnknownConfirm')"
                                            :aria-label="$t('networkUnknownConfirm') + ' ' + row.device.ip"
                                            :disabled="confirming"
                                            @click="confirmDevice(row.device)"
                                        >
                                            {{ $t("networkUnknownBadge") }}
                                            <font-awesome-icon icon="check" />
                                        </button>
                                        <router-link
                                            v-if="row.device.monitorId !== null"
                                            :to="'/dashboard/' + row.device.monitorId"
                                            class="badge bg-info text-decoration-none"
                                        >
                                            {{ $t("networkScanBadgeMonitored") }}
                                        </router-link>
                                        <span
                                            v-if="
                                                row.device.dependsOnId !== null && row.device.dependsOnId !== undefined
                                            "
                                            class="badge bg-secondary ms-1"
                                            :title="$t('networkDependsOnTitle', { name: parentName(row.device) })"
                                        >
                                            <font-awesome-icon icon="link" />
                                            {{ parentName(row.device) }}
                                        </span>
                                    </td>
                                    <td>
                                        <input
                                            type="text"
                                            class="form-control form-control-sm label-input"
                                            maxlength="255"
                                            :value="row.device.label"
                                            :placeholder="$t('networkScanLabelPlaceholder')"
                                            :aria-label="$t('networkScanColumnLabel') + ' ' + row.device.ip"
                                            @keydown.enter.prevent="$event.target.blur()"
                                            @change="saveLabel(row.device, $event.target.value)"
                                        />
                                    </td>
                                    <td>
                                        <select
                                            class="form-select form-select-sm category-select"
                                            :value="row.device.categoryId === null ? '' : String(row.device.categoryId)"
                                            :aria-label="$t('networkScanColumnCategory') + ' ' + row.device.ip"
                                            @change="changeCategory(row.device, $event.target.value)"
                                        >
                                            <option value="">{{ $t("networkScanNoCategory") }}</option>
                                            <option
                                                v-for="category in categories"
                                                :key="category.id"
                                                :value="String(category.id)"
                                            >
                                                {{ category.name }}
                                            </option>
                                        </select>
                                    </td>
                                    <td>
                                        <select
                                            class="form-select form-select-sm category-select"
                                            :value="
                                                row.device.subcategoryId === null
                                                    ? ''
                                                    : String(row.device.subcategoryId)
                                            "
                                            :disabled="subcategoriesOf(row.device.categoryId).length === 0"
                                            :aria-label="$t('networkScanColumnSubcategory') + ' ' + row.device.ip"
                                            @change="changeSubcategory(row.device, $event.target.value)"
                                        >
                                            <option value="">{{ $t("networkScanNoSubcategory") }}</option>
                                            <option
                                                v-for="sub in subcategoriesOf(row.device.categoryId)"
                                                :key="sub.id"
                                                :value="String(sub.id)"
                                            >
                                                {{ sub.name }}
                                            </option>
                                        </select>
                                    </td>
                                    <td class="text-nowrap">
                                        <span v-if="row.device.monitorId === null" class="small">
                                            {{ $t("networkUptimeNotMonitored") }}
                                        </span>
                                        <button
                                            v-else-if="uptimeByDevice[row.device.id]"
                                            type="button"
                                            class="btn btn-link btn-sm p-0 text-decoration-none"
                                            @click="openUptime(row.device)"
                                        >
                                            {{ uptimeText(uptimeByDevice[row.device.id]) }}
                                        </button>
                                        <span v-else class="small">-</span>
                                    </td>
                                    <td class="text-nowrap">
                                        <span
                                            v-if="row.device.monitorId !== null && hasPing(row.device.id)"
                                            :title="pingTitle(pingByDevice[row.device.id])"
                                        >
                                            <span
                                                class="ping-dot"
                                                :class="`ping-${pingLevelOf(pingByDevice[row.device.id])}`"
                                                aria-hidden="true"
                                            ></span>
                                            <span class="visually-hidden">
                                                {{ pingLevelText(pingByDevice[row.device.id]) }}
                                            </span>
                                            {{ pingText(pingByDevice[row.device.id]) }}
                                        </span>
                                        <span v-else class="small">{{ "—" }}</span>
                                    </td>
                                    <td>{{ row.device.hostname }}</td>
                                    <td class="text-nowrap">{{ row.device.mac }}</td>
                                    <td>{{ row.device.vendor }}</td>
                                    <td class="text-nowrap"><Datetime :value="row.device.lastSeen" /></td>
                                    <td class="text-end">
                                        <button
                                            type="button"
                                            class="btn btn-sm btn-normal text-danger"
                                            :aria-label="$t('networkScanDeleteDevice') + ' ' + row.device.ip"
                                            :title="$t('networkScanDeleteDevice')"
                                            @click="askDelete(row.device)"
                                        >
                                            <font-awesome-icon icon="trash" />
                                        </button>
                                    </td>
                                </tr>
                            </template>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Add to monitoring -->
            <div ref="addModal" class="modal fade" tabindex="-1">
                <div class="modal-dialog modal-lg modal-dialog-scrollable">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">{{ $t("networkScanDialogTitle") }}</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                        </div>
                        <div class="modal-body">
                            <form id="networkScanAddForm" @submit.prevent="submitAdd">
                                <div class="table-responsive mb-3">
                                    <table class="table align-middle mb-0">
                                        <thead>
                                            <tr>
                                                <th scope="col">{{ $t("networkScanColumnIp") }}</th>
                                                <th scope="col">{{ $t("networkScanMonitorType") }}</th>
                                                <th scope="col">{{ $t("networkScanPort") }}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr v-for="item in addForm.items" :key="item.id">
                                                <td class="text-nowrap">
                                                    {{ item.ip }}
                                                    <span v-if="item.name !== item.ip" class="text-muted">
                                                        ({{ item.name }})
                                                    </span>
                                                </td>
                                                <td>
                                                    <select
                                                        v-model="item.type"
                                                        class="form-select form-select-sm"
                                                        :aria-label="$t('networkScanMonitorType') + ' ' + item.ip"
                                                    >
                                                        <option value="ping">{{ $t("networkScanTypePing") }}</option>
                                                        <option value="port">{{ $t("networkScanTypePort") }}</option>
                                                        <option value="http">{{ $t("networkScanTypeHttp") }}</option>
                                                        <option value="rtsp">{{ $t("networkScanTypeRtsp") }}</option>
                                                        <option value="snmp">{{ $t("networkScanTypeSnmp") }}</option>
                                                    </select>
                                                </td>
                                                <td>
                                                    <div v-if="item.type !== 'ping'" class="d-flex flex-wrap gap-1">
                                                        <input
                                                            v-model="item.port"
                                                            type="number"
                                                            min="1"
                                                            max="65535"
                                                            :required="item.type === 'port'"
                                                            :placeholder="defaultPortOf(item.type)"
                                                            class="form-control form-control-sm port-input"
                                                            :aria-label="$t('networkScanPort') + ' ' + item.ip"
                                                        />
                                                        <input
                                                            v-if="item.type === 'http'"
                                                            v-model="item.path"
                                                            type="text"
                                                            maxlength="200"
                                                            placeholder="/"
                                                            class="form-control form-control-sm path-input"
                                                            :aria-label="$t('networkScanPath') + ' ' + item.ip"
                                                        />
                                                        <input
                                                            v-if="item.type === 'snmp'"
                                                            v-model="item.community"
                                                            type="text"
                                                            maxlength="64"
                                                            placeholder="public"
                                                            class="form-control form-control-sm path-input"
                                                            :aria-label="$t('networkScanCommunity') + ' ' + item.ip"
                                                        />
                                                    </div>
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>

                                <div class="row">
                                    <div class="col-md-6 mb-3">
                                        <label for="networkScanInterval" class="form-label">
                                            {{ $t("networkScanInterval") }}
                                        </label>
                                        <input
                                            id="networkScanInterval"
                                            v-model.number="addForm.interval"
                                            type="number"
                                            class="form-control"
                                            min="20"
                                            step="1"
                                            required
                                        />
                                    </div>
                                    <div class="col-md-6 mb-3">
                                        <label for="networkScanGroup" class="form-label">
                                            {{ $t("Monitor Group") }}
                                        </label>
                                        <select
                                            id="networkScanGroup"
                                            v-model="addForm.parent"
                                            class="form-select"
                                            aria-describedby="networkScanGroupHint"
                                        >
                                            <option :value="null">{{ $t("None") }}</option>
                                            <option v-for="group in groupList" :key="group.id" :value="group.id">
                                                {{ group.pathName || group.name }}
                                            </option>
                                        </select>
                                        <div id="networkScanGroupHint" class="form-text">
                                            {{ $t("networkScanGroupHint") }}
                                        </div>
                                    </div>
                                </div>

                                <div>
                                    <div class="form-label">{{ $t("Notifications") }}</div>
                                    <p v-if="$root.notificationList.length === 0" class="mb-0">
                                        {{ $t("Not available, please setup.") }}
                                    </p>
                                    <div
                                        v-for="notification in $root.notificationList"
                                        :key="notification.id"
                                        class="form-check form-switch my-2"
                                    >
                                        <input
                                            :id="'networkScanNotification' + notification.id"
                                            v-model="addForm.notificationIDList[notification.id]"
                                            class="form-check-input"
                                            type="checkbox"
                                        />
                                        <label
                                            class="form-check-label"
                                            :for="'networkScanNotification' + notification.id"
                                        >
                                            {{ notification.name }}
                                        </label>
                                    </div>
                                </div>
                            </form>

                            <div
                                v-if="addResult"
                                class="alert mt-3 mb-0"
                                :class="addResult.failed.length ? 'alert-warning' : 'alert-success'"
                                role="status"
                            >
                                {{
                                    $t("networkScanAddResult", {
                                        added: addResult.added,
                                        skipped: addResult.skipped,
                                        failed: addResult.failed.length,
                                    })
                                }}
                                <template v-if="addResult.failed.length">
                                    <div class="mt-2">{{ $t("networkScanAddFailedList") }}</div>
                                    <ul class="mb-0">
                                        <li v-for="failure in addResult.failed" :key="failure.id">
                                            {{ failureLabel(failure.id) }}: {{ failure.msg }}
                                        </li>
                                    </ul>
                                </template>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                                {{ $t("Close") }}
                            </button>
                            <button
                                type="submit"
                                form="networkScanAddForm"
                                class="btn btn-primary"
                                :disabled="adding || addForm.items.length === 0"
                            >
                                <font-awesome-icon icon="plus" />
                                {{ $t("Confirm") }}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <NetworkScheduleDialog ref="scheduleDialog" :suggested-ranges="rangesText" />
            <NetworkReportDialog ref="reportDialog" />
            <NetworkImportDialog ref="importDialog" :group-list="groupList" :categories="categories" />

            <NetworkHistoryDialog
                ref="historyDialog"
                :devices="visibleDevices"
                :categories="categories"
                :filter-active="filterActive"
                :filter-label="filterLabelText"
                :model-value="period"
                @update:model-value="onPeriodChange"
                @open-device="openUptime"
            />

            <NetworkUptimeDialog
                ref="uptimeDialog"
                :device="uptimeDevice"
                :model-value="period"
                @update:model-value="onPeriodChange"
            />

            <!-- Manage categories -->
            <div ref="categoryModal" class="modal fade" tabindex="-1">
                <div class="modal-dialog modal-lg modal-dialog-scrollable">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">{{ $t("networkScanCategoryDialogTitle") }}</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                        </div>
                        <div class="modal-body">
                            <p class="form-text mt-0 mb-2">{{ $t("networkScanCategoryGroupsNote") }}</p>
                            <p v-if="categories.length === 0" class="mb-3">{{ $t("networkScanNoCategories") }}</p>

                            <div v-for="category in categories" :key="category.id" class="category-block mb-3">
                                <div class="input-group">
                                    <input
                                        type="text"
                                        class="form-control fw-bold"
                                        maxlength="100"
                                        :value="category.name"
                                        :aria-label="$t('networkScanColumnCategory')"
                                        @keydown.enter.prevent="$event.target.blur()"
                                        @change="renameCategory(category, $event.target)"
                                    />
                                    <button
                                        type="button"
                                        class="btn"
                                        :class="pendingDeleteId === category.id ? 'btn-danger' : 'btn-outline-danger'"
                                        :aria-label="$t('networkScanDeleteCategory') + ' ' + category.name"
                                        @click="deleteCategory(category)"
                                        @blur="pendingDeleteId = null"
                                    >
                                        <template v-if="pendingDeleteId === category.id">
                                            {{ $t("networkScanConfirmDeleteCategory") }}
                                        </template>
                                        <font-awesome-icon v-else icon="trash" />
                                    </button>
                                </div>
                                <div v-if="pendingDeleteId === category.id" class="form-text text-danger">
                                    {{ $t("networkScanCategoryDeleteHint") }}
                                </div>

                                <div class="sub-list">
                                    <div
                                        v-for="sub in category.subcategories"
                                        :key="sub.id"
                                        class="input-group input-group-sm mt-2"
                                    >
                                        <input
                                            type="text"
                                            class="form-control"
                                            maxlength="100"
                                            :value="sub.name"
                                            :aria-label="$t('networkScanColumnSubcategory')"
                                            @keydown.enter.prevent="$event.target.blur()"
                                            @change="renameCategory(sub, $event.target)"
                                        />
                                        <button
                                            type="button"
                                            class="btn"
                                            :class="pendingDeleteId === sub.id ? 'btn-danger' : 'btn-outline-danger'"
                                            :aria-label="$t('networkScanDeleteCategory') + ' ' + sub.name"
                                            @click="deleteCategory(sub)"
                                            @blur="pendingDeleteId = null"
                                        >
                                            <template v-if="pendingDeleteId === sub.id">
                                                {{ $t("networkScanConfirmDeleteCategory") }}
                                            </template>
                                            <font-awesome-icon v-else icon="trash" />
                                        </button>
                                    </div>
                                    <div
                                        v-if="category.subcategories.some((sub) => sub.id === pendingDeleteId)"
                                        class="form-text text-danger"
                                    >
                                        {{ $t("networkScanSubcategoryDeleteHint") }}
                                    </div>

                                    <form
                                        class="input-group input-group-sm mt-2"
                                        @submit.prevent="addSubcategory(category)"
                                    >
                                        <input
                                            v-model="newSubNames[category.id]"
                                            type="text"
                                            class="form-control"
                                            maxlength="100"
                                            :placeholder="$t('networkScanNewSubcategory')"
                                            :aria-label="$t('networkScanNewSubcategory') + ' ' + category.name"
                                        />
                                        <button type="submit" class="btn btn-outline-primary">
                                            <font-awesome-icon icon="plus" />
                                            {{ $t("networkScanAdd") }}
                                        </button>
                                    </form>
                                </div>
                            </div>

                            <form class="input-group" @submit.prevent="addCategory">
                                <input
                                    v-model="newCategoryName"
                                    type="text"
                                    class="form-control"
                                    maxlength="100"
                                    :placeholder="$t('networkScanNewCategory')"
                                    :aria-label="$t('networkScanNewCategory')"
                                />
                                <button type="submit" class="btn btn-primary">
                                    <font-awesome-icon icon="plus" />
                                    {{ $t("networkScanAdd") }}
                                </button>
                            </form>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                                {{ $t("Close") }}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <Confirm
                ref="confirmDelete"
                btn-style="btn-danger"
                :yes-text="$t('Yes')"
                :no-text="$t('No')"
                @yes="deleteDevice"
            >
                {{ $t("networkScanDeleteConfirm", { ip: deleting ? deleting.ip : "" }) }}
            </Confirm>
        </div>
    </transition>
</template>

<script>
import { Modal } from "bootstrap";
import Confirm from "../components/Confirm.vue";
import Datetime from "../components/Datetime.vue";
import NetworkHistoryDialog from "../components/NetworkHistoryDialog.vue";
import NetworkImportDialog from "../components/NetworkImportDialog.vue";
import NetworkScheduleDialog from "../components/NetworkScheduleDialog.vue";
import NetworkReportDialog from "../components/NetworkReportDialog.vue";
import NetworkPeriodPicker from "../components/NetworkPeriodPicker.vue";
import NetworkUptimeDialog from "../components/NetworkUptimeDialog.vue";
import { filterDevices, filterLabel, isFilterActive, normalizeFilter } from "../network-device-filter.js";
import { formatPing, pingLevel, PING_FAIR_MAX, PING_GOOD_MAX } from "../network-ping-format.js";
import { buildUptimeCsv, csvFileName, formatDuration, formatPercent, resolveRange } from "../network-uptime-format.js";

/** Same limit as the server (MAX_HOSTS in server/network-scanner.js); the server enforces it. */
const MAX_HOSTS = 4096;

export default {
    components: {
        Confirm,
        Datetime,
        NetworkHistoryDialog,
        NetworkImportDialog,
        NetworkPeriodPicker,
        NetworkScheduleDialog,
        NetworkReportDialog,
        NetworkUptimeDialog,
    },

    data() {
        return {
            confirming: false,
            maxHosts: MAX_HOSTS,
            rangesText: "",
            starting: false,
            scanning: false,
            scanId: null,
            progress: { done: 0, total: 0, found: 0 },
            summary: null,
            scanError: null,
            devices: [],
            categories: [],
            collapsed: {},
            categoryModal: null,
            newCategoryName: "",
            newSubNames: {},
            pendingDeleteId: null,
            selectedIds: [],
            categoryFilter: { categoryId: null, subcategoryId: null },
            bulkCategory: "",
            bulkSub: "",
            bulkParent: "",
            bulkBusy: false,
            period: { preset: "24h" },
            uptimeByDevice: {},
            uptimeRange: null,
            uptimeSeq: 0,
            uptimeLoading: false,
            uptimeDevice: null,
            pingByDevice: {},
            pingSeq: 0,
            pingLoading: false,
            deviceSignature: null,
            deleting: null,
            addModal: null,
            adding: false,
            addResult: null,
            addForm: {
                items: [],
                interval: 60,
                parent: null,
                notificationIDList: {},
            },
        };
    },

    computed: {
        unknownDevices() {
            return this.devices.filter((d) => !d.acknowledged);
        },

        percent() {
            if (!this.progress.total) {
                return 0;
            }
            return Math.min(100, Math.floor((this.progress.done / this.progress.total) * 100));
        },

        /**
         * The devices that match the category filter. The table, the checkboxes, the uptime and ping columns, the
         * history dialog and the CSV files all work on these.
         * @returns {object[]} Devices
         */
        visibleDevices() {
            return filterDevices(this.devices, this.categoryFilter);
        },

        filterActive() {
            return isFilterActive(this.categoryFilter);
        },

        filterLabelText() {
            return filterLabel(this.categoryFilter, this.categories, this.$t("networkFilterNone"));
        },

        /**
         * @returns {object|undefined} The category chosen in the filter (not for "no category")
         */
        filterCategory() {
            return this.categories.find((category) => category.id === this.categoryFilter.categoryId);
        },

        /**
         * @returns {object|undefined} The category chosen in the action bar
         */
        bulkCategoryObject() {
            return this.categories.find((category) => String(category.id) === this.bulkCategory);
        },

        /**
         * @returns {number[]} Ids of the visible devices that have a monitor
         */
        visibleMonitoredIds() {
            return this.visibleDevices.filter((device) => device.monitorId !== null).map((device) => device.id);
        },

        /**
         * Devices that can be checked: those with a row on screen (inside the filter and not in a collapsed group).
         * @returns {object[]} Devices
         */
        selectableDevices() {
            return this.tableRows.filter((row) => row.kind === "device").map((row) => row.device);
        },

        /**
         * @returns {object[]} The visible devices that are checked
         */
        selectedDevices() {
            return this.selectableDevices.filter((device) => this.selectedIds.includes(device.id));
        },

        /**
         * @returns {object[]} The checked devices that do not have a monitor yet (those can be added to monitoring)
         */
        selectedUnmonitored() {
            return this.selectedDevices.filter((device) => device.monitorId === null);
        },

        /**
         * Devices a checked device can depend on: those that have a monitor and are not checked themselves.
         * @returns {object[]} Devices
         */
        parentChoices() {
            const checked = new Set(this.selectedIds);
            return this.devices.filter((device) => device.monitorId !== null && !checked.has(device.id));
        },

        allSelected() {
            return this.selectableDevices.length > 0 && this.selectedDevices.length === this.selectableDevices.length;
        },

        /**
         * The rows of the device table: group headers (category, sub category) followed by their devices.
         * Groups without devices are left out, and so are headers when nothing is categorized.
         * @returns {object[]} Rows
         */
        tableRows() {
            const known = new Map(this.categories.map((category) => [category.id, category]));
            const rows = [];

            /**
             * Add a header row and, unless collapsed, its devices.
             * @param {string} key Collapse key
             * @param {string} kind "category" or "subcategory"
             * @param {string} name Title
             * @param {object[]} devices Devices of the group (all of them, for the count)
             * @param {number} depth Indent level of the devices
             * @returns {boolean} True when the devices are shown
             */
            const header = (key, kind, name, devices, depth) => {
                const collapsed = Boolean(this.collapsed[key]);
                rows.push({ key, kind, name, count: devices.length, collapsed, depth });
                return !collapsed;
            };
            const addDevices = (devices, depth) => {
                for (const device of devices) {
                    rows.push({ key: "d" + device.id, kind: "device", device, depth });
                }
            };

            const inCategory = (category) =>
                this.visibleDevices.filter(
                    (device) => device.categoryId === category.id && known.has(device.categoryId)
                );
            const uncategorized = this.visibleDevices.filter((device) => !known.has(device.categoryId));

            let anyCategorized = false;
            for (const category of this.categories) {
                const devices = inCategory(category);
                if (devices.length === 0) {
                    continue;
                }
                anyCategorized = true;
                if (!header("c" + category.id, "category", category.name, devices, 1)) {
                    continue;
                }

                const subs = category.subcategories.filter((sub) => devices.some((d) => d.subcategoryId === sub.id));
                const loose = devices.filter((d) => !subs.some((sub) => sub.id === d.subcategoryId));
                for (const sub of subs) {
                    const subDevices = devices.filter((d) => d.subcategoryId === sub.id);
                    if (header("s" + sub.id, "subcategory", sub.name, subDevices, 2)) {
                        addDevices(subDevices, 2);
                    }
                }
                if (loose.length > 0) {
                    if (subs.length === 0) {
                        addDevices(loose, 1);
                    } else if (
                        header("n" + category.id, "subcategory", this.$t("networkScanNoSubcategory"), loose, 2)
                    ) {
                        addDevices(loose, 2);
                    }
                }
            }

            if (uncategorized.length > 0) {
                if (!anyCategorized) {
                    addDevices(uncategorized, 0);
                } else if (header("none", "category", this.$t("networkScanNoCategory"), uncategorized, 1)) {
                    addDevices(uncategorized, 1);
                }
            }
            return rows;
        },

        /**
         * @returns {boolean} True when at least one device is monitored
         */
        hasMonitoredDevice() {
            return this.visibleDevices.some((d) => d.monitorId !== null);
        },

        /**
         * The uptime of the monitored devices, as loaded for the chosen period.
         * @returns {object[]} Summary items
         */
        uptimeItems() {
            return this.visibleDevices.map((device) => this.uptimeByDevice[device.id]).filter(Boolean);
        },

        durationUnits() {
            return {
                day: this.$t("networkUptimeUnitDay"),
                hour: this.$t("networkUptimeUnitHour"),
                minute: this.$t("networkUptimeUnitMinute"),
                second: this.$t("networkUptimeUnitSecond"),
            };
        },

        groupList() {
            return Object.values(this.$root.monitorList)
                .filter((monitor) => monitor.type === "group")
                .sort((a, b) => (a.pathName || a.name).localeCompare(b.pathName || b.name));
        },
    },

    watch: {
        // The socket reconnected: pick the running scan (if any) and the inventory up again.
        "$root.socket.connectCount"() {
            // An answer to "Apply" sent before the connection dropped never comes back
            this.bulkBusy = false;
            this.loadAll();
        },

        "$root.socket.connected"(connected) {
            if (!connected) {
                this.bulkBusy = false;
            }
        },
    },

    mounted() {
        this.addModal = new Modal(this.$refs.addModal);
        this.categoryModal = new Modal(this.$refs.categoryModal);

        const socket = this.$root.getSocket();
        socket.on("networkScanProgress", this.onProgress);
        socket.on("networkScanDone", this.onDone);
        socket.on("networkDeviceList", this.onDeviceList);
        socket.on("networkCategoryList", this.onCategoryList);

        this.loadAll();
    },

    beforeUnmount() {
        const socket = this.$root.getSocket();
        socket.off("networkScanProgress", this.onProgress);
        socket.off("networkScanDone", this.onDone);
        socket.off("networkDeviceList", this.onDeviceList);
        socket.off("networkCategoryList", this.onCategoryList);

        for (const modal of [this.addModal, this.categoryModal]) {
            if (modal) {
                try {
                    modal.hide();
                } catch (e) {
                    console.warn("Modal hide failed:", e);
                }
            }
        }
    },

    methods: {
        /**
         * Load the subnets, the inventory and the state of a running scan.
         * @returns {void}
         */
        loadAll() {
            const socket = this.$root.getSocket();
            // Whatever the devices look like now, load the uptime again once they arrive.
            this.deviceSignature = null;

            socket.emit("getLocalSubnets", (res) => {
                if (res.ok && this.rangesText.trim() === "") {
                    this.rangesText = res.subnets.join("\n");
                }
            });
            socket.emit("getNetworkCategories", (res) => {
                if (res.ok) {
                    this.onCategoryList(res.categories);
                }
            });
            socket.emit("getNetworkDevices", (res) => {
                if (res.ok) {
                    this.onDeviceList(res.devices);
                }
            });
            socket.emit("getNetworkScanStatus", (res) => {
                if (res.ok && res.running) {
                    this.scanning = true;
                    this.scanId = res.scanId;
                    this.progress = { done: res.done, total: res.total, found: res.found };
                }
            });
        },

        /**
         * Start a scan of the typed ranges.
         * @returns {void}
         */
        startScan() {
            this.starting = true;
            this.summary = null;
            this.scanError = null;
            this.$root.getSocket().emit("startNetworkScan", { ranges: this.rangesText.split(/\r?\n/) }, (res) => {
                this.starting = false;
                if (res.ok) {
                    this.scanning = true;
                    this.scanId = res.scanId;
                    this.progress = { done: 0, total: 0, found: 0 };
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Ask the server to stop the running scan.
         * @returns {void}
         */
        cancelScan() {
            this.$root.getSocket().emit("cancelNetworkScan", { scanId: this.scanId }, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Progress of a scan (also one started in another browser tab).
         * @param {{scanId: number, done: number, total: number, found: number}} data Progress
         * @returns {void}
         */
        onProgress(data) {
            this.scanning = true;
            this.scanId = data.scanId;
            this.progress = { done: data.done, total: data.total, found: data.found };
        },

        /**
         * A scan ended: finished, cancelled or failed.
         * @param {{scanId: number, cancelled: boolean, error?: string, summary?: object}} data Result
         * @returns {void}
         */
        onDone(data) {
            this.scanning = false;
            this.scanId = null;
            if (data.error) {
                this.scanError = data.error;
                this.summary = null;
            } else {
                this.scanError = null;
                this.summary = { ...data.summary, cancelled: data.cancelled };
            }
        },

        /**
         * The inventory changed.
         * @param {object[]} devices Devices
         * @returns {void}
         */
        onDeviceList(devices) {
            this.devices = devices;
            // The uptime only changes with the set of monitored devices, not with every label edit. Under a filter it
            // is also needed when a monitored device came into the filter (a device that left it is just not shown).
            const signature = this.signatureOf(devices);
            const missing = this.filterActive && this.visibleMonitoredIds.some((id) => !this.uptimeByDevice[id]);
            if (signature !== this.deviceSignature || missing) {
                this.deviceSignature = signature;
                this.loadUptimeSummary();
                this.loadPingSummary();
            }
            const visible = new Set(this.visibleDevices.map((d) => d.id));
            this.selectedIds = this.selectedIds.filter((id) => visible.has(id));
        },

        /**
         * What the uptime and ping columns depend on: which devices are monitored.
         * @param {object[]} devices Devices
         * @returns {string} A text that changes when the columns must be loaded again
         */
        signatureOf(devices) {
            return devices.map((d) => `${d.id}:${d.monitorId}`).join(",");
        },

        /**
         * Change the category filter: uncheck what is no longer visible and load the columns again.
         * @param {{categoryId: null|"none"|number, subcategoryId: null|number}} next The new filter
         * @returns {void}
         */
        applyFilter(next) {
            this.categoryFilter = normalizeFilter(next, this.categories);
            const visible = new Set(this.visibleDevices.map((d) => d.id));
            this.selectedIds = this.selectedIds.filter((id) => visible.has(id));
            this.deviceSignature = this.signatureOf(this.devices);
            this.loadUptimeSummary();
            this.loadPingSummary();
        },

        /**
         * The category dropdown of the filter was changed.
         * @param {string} value "" for all, "none" for no category, or a category id
         * @returns {void}
         */
        onFilterCategory(value) {
            const categoryId = value === "" ? null : value === "none" ? "none" : Number(value);
            this.applyFilter({ categoryId, subcategoryId: null });
        },

        /**
         * The sub category dropdown of the filter was changed.
         * @param {string} value "" for all, or a sub category id
         * @returns {void}
         */
        onFilterSub(value) {
            this.applyFilter({ ...this.categoryFilter, subcategoryId: value === "" ? null : Number(value) });
        },

        /**
         * Put the checked devices in the category and sub category chosen in the action bar.
         * @returns {void}
         */
        applyBulkCategory() {
            if (this.bulkBusy || this.bulkCategory === "" || this.selectedDevices.length === 0) {
                return;
            }
            this.bulkBusy = true;
            const payload = {
                ids: this.selectedDevices.map((device) => device.id),
                categoryId: this.bulkCategory === "none" ? null : Number(this.bulkCategory),
                subcategoryId: this.bulkSub === "" ? null : Number(this.bulkSub),
            };
            this.$root.getSocket().emit("setNetworkDevicesCategory", payload, (res) => {
                this.bulkBusy = false;
                if (res.ok) {
                    this.$root.toastRes({ ok: true, msg: this.$t("networkBulkDone", { count: res.updated }) });
                    this.clearSelection();
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Make the checked devices depend on the device chosen in the action bar (or on nothing).
         * @returns {void}
         */
        applyBulkDependency() {
            if (this.bulkBusy || this.bulkParent === "" || this.selectedDevices.length === 0) {
                return;
            }
            this.bulkBusy = true;
            const payload = {
                ids: this.selectedDevices.map((device) => device.id),
                dependsOnId: this.bulkParent === "none" ? null : Number(this.bulkParent),
            };
            this.$root.getSocket().emit("setNetworkDevicesDependency", payload, (res) => {
                this.bulkBusy = false;
                if (res.ok) {
                    this.$root.toastRes({ ok: true, msg: this.$t("networkBulkDone", { count: res.updated }) });
                    this.clearSelection();
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * @param {object} device Device from the inventory
         * @returns {string} Label, or the IP address when it has none
         */
        deviceName(device) {
            return device.label || device.ip;
        },

        /**
         * @param {object} device A device that depends on another
         * @returns {string} Name of the device it depends on
         */
        parentName(device) {
            const parent = this.devices.find((d) => d.id === device.dependsOnId);
            return parent ? this.deviceName(parent) : "?";
        },

        /**
         * Uncheck every device and reset the action bar.
         * @returns {void}
         */
        clearSelection() {
            this.selectedIds = [];
            this.bulkCategory = "";
            this.bulkSub = "";
            this.bulkParent = "";
        },

        /**
         * The categories changed.
         * @param {object[]} categories Categories with their sub categories
         * @returns {void}
         */
        onCategoryList(categories) {
            this.categories = categories;
            // A category or sub category of the filter may be gone (deleted here or on another screen)
            const normalized = normalizeFilter(this.categoryFilter, categories);
            if (
                normalized.categoryId !== this.categoryFilter.categoryId ||
                normalized.subcategoryId !== this.categoryFilter.subcategoryId
            ) {
                this.applyFilter(normalized);
            }
            if (this.bulkCategory !== "" && this.bulkCategory !== "none" && !this.bulkCategoryObject) {
                this.bulkCategory = "";
                this.bulkSub = "";
            } else if (
                this.bulkSub !== "" &&
                !(this.bulkCategoryObject?.subcategories || []).some((sub) => String(sub.id) === this.bulkSub)
            ) {
                // The chosen sub category was deleted
                this.bulkSub = "";
            }
        },

        /**
         * Load the uptime of all monitored devices for the chosen period. Only the newest request may change what is
         * shown, so a slow answer for an earlier period never replaces the answer for the current one.
         * @returns {void}
         */
        loadUptimeSummary() {
            const seq = ++this.uptimeSeq;
            const { from, to } = resolveRange(this.period);
            if (this.filterActive && this.visibleMonitoredIds.length === 0) {
                // Nothing to ask for: no monitored device in the filter
                this.uptimeLoading = false;
                this.uptimeByDevice = {};
                return;
            }
            const payload = this.filterActive ? { from, to, deviceIds: this.visibleMonitoredIds } : { from, to };
            this.uptimeLoading = true;
            this.$root.getSocket().emit("getNetworkUptimeSummary", payload, (res) => {
                if (seq !== this.uptimeSeq) {
                    return;
                }
                this.uptimeLoading = false;
                if (res.ok) {
                    this.uptimeByDevice = Object.fromEntries(res.items.map((item) => [item.deviceId, item]));
                    this.uptimeRange = { from, to: res.items.length > 0 ? res.items[0].effectiveTo : to };
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * The period was changed in the picker (on the page or in the dialog).
         * @param {object} period The new period
         * @returns {void}
         */
        onPeriodChange(period) {
            this.period = period;
            this.loadUptimeSummary();
            this.loadPingSummary();
        },

        /**
         * Load the uptime and the ping again.
         * @returns {void}
         */
        refreshSummaries() {
            this.loadUptimeSummary();
            this.loadPingSummary();
        },

        /**
         * Load the ping of all monitored devices for the chosen period. Only the newest request may change what is
         * shown. A failure only shows a message; the uptime column is not touched.
         * @returns {void}
         */
        loadPingSummary() {
            const seq = ++this.pingSeq;
            const { from, to } = resolveRange(this.period);
            if (this.filterActive && this.visibleMonitoredIds.length === 0) {
                this.pingLoading = false;
                this.pingByDevice = {};
                return;
            }
            const payload = this.filterActive ? { from, to, deviceIds: this.visibleMonitoredIds } : { from, to };
            this.pingLoading = true;
            this.$root.getSocket().emit("getNetworkPingSummary", payload, (res) => {
                if (seq !== this.pingSeq) {
                    return;
                }
                this.pingLoading = false;
                if (res.ok) {
                    this.pingByDevice = Object.fromEntries(res.summary.items.map((item) => [item.deviceId, item]));
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * @param {number} deviceId Device id
         * @returns {boolean} True when the device has a ping for the period
         */
        hasPing(deviceId) {
            const item = this.pingByDevice[deviceId];
            return !!item && item.samples > 0 && item.avg !== null;
        },

        /**
         * @param {object} item Ping summary item
         * @returns {string} The level class name: good, fair or slow
         */
        pingLevelOf(item) {
            return pingLevel(item.avg);
        },

        /**
         * @param {object} item Ping summary item
         * @returns {string} The level in words, for screen readers
         */
        pingLevelText(item) {
            const level = pingLevel(item.avg);
            return level ? this.$t("networkPingLevel" + level[0].toUpperCase() + level.slice(1)) : "";
        },

        /**
         * @param {object} item Ping summary item
         * @returns {string} The average ping, for example "12 ms"
         */
        pingText(item) {
            return formatPing(item.avg, this.$i18n.locale);
        },

        /**
         * Tooltip of the ping cell: lowest, highest and what the colours mean.
         * @param {object} item Ping summary item
         * @returns {string} The text
         */
        pingTitle(item) {
            const locale = this.$i18n.locale;
            return this.$t("networkPingCellTitle", {
                min: formatPing(item.min, locale),
                max: formatPing(item.max, locale),
                good: PING_GOOD_MAX,
                fair: PING_FAIR_MAX,
            });
        },

        /**
         * Open the history and ping dialog.
         * @returns {void}
         */
        openHistory() {
            this.$refs.historyDialog.show();
        },

        /**
         * Text of the uptime cell: percentage and the time the device was up.
         * @param {object} item Summary item of the device
         * @returns {string} For example "99,2% · 23j 48m"
         */
        uptimeText(item) {
            if (item.uptimePercent === null) {
                return this.$t("networkUptimeNoData");
            }
            const percent = formatPercent(item.uptimePercent, this.$i18n.locale);
            return `${percent}% · ${formatDuration(item.upSeconds, this.durationUnits, 2)}`;
        },

        /**
         * Open the detail dialog of a device.
         * @param {object} device Device
         * @returns {void}
         */
        openUptime(device) {
            this.uptimeDevice = device;
            this.$nextTick(() => this.$refs.uptimeDialog.show());
        },

        /**
         * Download the uptime of the monitored devices for the period on screen as a CSV file.
         * @returns {void}
         */
        exportCsv() {
            if (!this.uptimeRange || this.uptimeItems.length === 0) {
                return;
            }
            const categoryOf = (id) => this.categories.find((c) => c.id === id);
            const headers = [
                this.$t("networkScanColumnCategory"),
                this.$t("networkScanColumnSubcategory"),
                this.$t("networkScanColumnLabel"),
                this.$t("networkScanColumnIp"),
                this.$t("networkUptimeCsvStart"),
                this.$t("networkUptimeCsvEnd"),
                this.$t("networkUptimeCsvUp"),
                this.$t("networkUptimeCsvDown"),
                this.$t("networkUptimeCsvMaintenance"),
                this.$t("networkUptimeCsvNoData"),
                this.$t("networkUptimeCsvPercent"),
                this.$t("networkUptimeCsvDownCount"),
            ];
            const rows = [];
            for (const device of this.visibleDevices) {
                const item = this.uptimeByDevice[device.id];
                if (!item) {
                    continue;
                }
                const category = categoryOf(device.categoryId);
                const sub = category ? category.subcategories.find((s) => s.id === device.subcategoryId) : null;
                rows.push([
                    category ? category.name : "",
                    sub ? sub.name : "",
                    device.label,
                    device.ip,
                    this.$root.datetime(this.uptimeRange.from),
                    this.$root.datetime(item.effectiveTo),
                    item.upSeconds,
                    item.downSeconds,
                    item.maintenanceSeconds,
                    item.noDataSeconds,
                    item.uptimePercent === null ? null : Math.round(item.uptimePercent * 100) / 100,
                    item.downCount,
                ]);
            }

            const blob = new Blob([buildUptimeCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = csvFileName(this.uptimeRange.from, this.uptimeRange.to);
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        },

        /**
         * Sub categories of a category.
         * @param {number|null} categoryId Category id
         * @returns {object[]} Sub categories (empty without a category)
         */
        subcategoriesOf(categoryId) {
            const category = this.categories.find((c) => c.id === categoryId);
            return category ? category.subcategories : [];
        },

        /**
         * Show or hide the devices of a group.
         * @param {string} key Group key
         * @returns {void}
         */
        toggleGroup(key) {
            this.collapsed = { ...this.collapsed, [key]: !this.collapsed[key] };
            // Devices of a collapsed group are not on screen any more, so they are unchecked (same as the filter)
            const shown = new Set(this.selectableDevices.map((device) => device.id));
            this.selectedIds = this.selectedIds.filter((id) => shown.has(id));
        },

        /**
         * Send a category choice for a device to the server.
         * @param {object} device Device
         * @param {number|null} categoryId Category id
         * @param {number|null} subcategoryId Sub category id
         * @returns {void}
         */
        saveDeviceCategory(device, categoryId, subcategoryId) {
            this.$root
                .getSocket()
                .emit("setNetworkDeviceCategory", { id: device.id, categoryId, subcategoryId }, (res) => {
                    if (!res.ok) {
                        this.$root.toastRes(res);
                        // Put the stored choice back in the dropdowns.
                        this.devices = [...this.devices];
                    }
                });
        },

        /**
         * The category dropdown of a device changed; the sub category is cleared.
         * @param {object} device Device
         * @param {string} value Selected option value ("" for none)
         * @returns {void}
         */
        changeCategory(device, value) {
            this.saveDeviceCategory(device, value === "" ? null : Number(value), null);
        },

        /**
         * The sub category dropdown of a device changed.
         * @param {object} device Device
         * @param {string} value Selected option value ("" for none)
         * @returns {void}
         */
        changeSubcategory(device, value) {
            this.saveDeviceCategory(device, device.categoryId, value === "" ? null : Number(value));
        },

        /**
         * Open the "manage categories" dialog.
         * @returns {void}
         */
        openCategoryDialog() {
            this.pendingDeleteId = null;
            this.categoryModal.show();
        },

        /**
         * Add a category with the typed name.
         * @returns {void}
         */
        addCategory() {
            const name = this.newCategoryName.trim();
            if (name === "") {
                return;
            }
            this.$root.getSocket().emit("addNetworkCategory", { name }, (res) => {
                if (res.ok) {
                    this.newCategoryName = "";
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Add a sub category to a category.
         * @param {object} category Category
         * @returns {void}
         */
        addSubcategory(category) {
            const name = (this.newSubNames[category.id] || "").trim();
            if (name === "") {
                return;
            }
            this.$root.getSocket().emit("addNetworkCategory", { name, parentId: category.id }, (res) => {
                if (res.ok) {
                    this.newSubNames = { ...this.newSubNames, [category.id]: "" };
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Rename a category or sub category from its input.
         * @param {{id: number, name: string}} item Category or sub category
         * @param {HTMLInputElement} input The input that holds the new name
         * @returns {void}
         */
        renameCategory(item, input) {
            this.$root.getSocket().emit("renameNetworkCategory", { id: item.id, name: input.value }, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                    // Put the stored name back.
                    input.value = item.name;
                }
            });
        },

        /**
         * Delete a category or sub category after a second click on the same button.
         * @param {{id: number}} item Category or sub category
         * @returns {void}
         */
        deleteCategory(item) {
            if (this.pendingDeleteId !== item.id) {
                this.pendingDeleteId = item.id;
                return;
            }
            this.pendingDeleteId = null;
            this.$root.getSocket().emit("deleteNetworkCategory", { id: item.id }, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * A device seen by exactly one scan counts as new.
         * @param {object} device Device
         * @returns {boolean} True if new
         */
        isNewDevice(device) {
            return device.isOnline && device.firstSeen === device.lastSeen;
        },

        /**
         * The port a monitor type uses when the port is left empty.
         * @param {string} type Monitor type
         * @returns {string} Port, as a placeholder text
         */
        defaultPortOf(type) {
            return { http: "80", rtsp: "554", snmp: "161" }[type] || "";
        },

        /**
         * Open the dialog of the monthly report.
         * @returns {void}
         */
        openReportDialog() {
            this.$refs.reportDialog.show();
        },

        /**
         * Open the dialog of the scheduled scan.
         * @returns {void}
         */
        openScheduleDialog() {
            this.$refs.scheduleDialog.show();
        },

        /**
         * Confirm one unknown device as known.
         * @param {object} device Device
         * @returns {void}
         */
        confirmDevice(device) {
            this.sendConfirm({ ids: [device.id] });
        },

        /**
         * Confirm every unknown device as known.
         * @returns {void}
         */
        confirmAll() {
            this.sendConfirm({ all: true });
        },

        /**
         * Ask the server to confirm devices as known.
         * @param {{ids?: number[], all?: boolean}} payload What to confirm
         * @returns {void}
         */
        sendConfirm(payload) {
            this.confirming = true;
            this.$root.getSocket().emit("acknowledgeNetworkDevices", payload, (res) => {
                this.confirming = false;
                if (res.ok) {
                    this.$root.toastSuccess(this.$t("networkUnknownConfirmed", { count: res.updated }));
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Select or clear every device that has a row on screen.
         * @param {boolean} checked New state of the header checkbox
         * @returns {void}
         */
        toggleAll(checked) {
            this.selectedIds = checked ? this.selectableDevices.map((device) => device.id) : [];
        },

        /**
         * Save the label of a device.
         * @param {object} device Device
         * @param {string} value New label
         * @returns {void}
         */
        saveLabel(device, value) {
            this.$root.getSocket().emit("updateNetworkDevice", { id: device.id, label: value }, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                    // Put the stored label back.
                    this.devices = [...this.devices];
                }
            });
        },

        /**
         * Ask before removing a device from the list.
         * @param {object} device Device
         * @returns {void}
         */
        askDelete(device) {
            this.deleting = device;
            this.$refs.confirmDelete.show();
        },

        /**
         * Remove the device chosen in the confirm dialog.
         * @returns {void}
         */
        deleteDevice() {
            if (!this.deleting) {
                return;
            }
            this.$root.getSocket().emit("deleteNetworkDevice", { id: this.deleting.id }, (res) => {
                this.$root.toastRes(res);
            });
        },

        /**
         * Open the dialog that imports devices from an Excel file.
         * @returns {void}
         */
        openImportDialog() {
            this.$refs.importDialog.show();
        },

        /**
         * Open the "add to monitoring" dialog for the selected devices.
         * @returns {void}
         */
        openAddDialog() {
            const notificationIDList = {};
            for (const notification of this.$root.notificationList) {
                if (notification.isDefault === true) {
                    notificationIDList[notification.id] = true;
                }
            }
            this.addResult = null;
            this.addForm = {
                items: this.selectedUnmonitored.map((device) => ({
                    id: device.id,
                    ip: device.ip,
                    name: device.label || device.hostname || device.ip,
                    type: "ping",
                    port: "",
                    path: "",
                    community: "",
                })),
                interval: 60,
                parent: null,
                notificationIDList,
            };
            this.addModal.show();
        },

        /**
         * Create the monitors.
         * @returns {void}
         */
        submitAdd() {
            this.adding = true;
            const payload = {
                devices: this.addForm.items.map((item) => ({
                    id: item.id,
                    type: item.type,
                    ...(item.type !== "ping" && String(item.port ?? "").trim() !== "" ? { port: item.port } : {}),
                    ...(item.type === "http" && item.path.trim() !== "" ? { path: item.path } : {}),
                    ...(item.type === "snmp" && item.community.trim() !== "" ? { community: item.community } : {}),
                })),
                interval: this.addForm.interval,
                parent: this.addForm.parent,
                notificationIDList: this.addForm.notificationIDList,
            };
            this.$root.getSocket().emit("addDevicesToMonitoring", payload, (res) => {
                this.adding = false;
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.addResult = { added: res.added, skipped: res.skipped, failed: res.failed };
                // The devices that were handled are not checked any more; only the failed ones stay checked
                const handled = new Set(this.addForm.items.map((item) => item.id));
                const failed = new Set(res.failed.map((failure) => failure.id));
                this.selectedIds = this.selectedIds.filter((id) => !handled.has(id) || failed.has(id));
                if (res.failed.length === 0) {
                    this.$root.toastRes({
                        ok: true,
                        msg: this.$t("networkScanAddResult", { added: res.added, skipped: res.skipped, failed: 0 }),
                    });
                    this.addModal.hide();
                } else {
                    // Keep only the devices that failed, so the user can fix them and try again.
                    const failedIds = new Set(res.failed.map((failure) => failure.id));
                    this.addForm.items = this.addForm.items.filter((item) => failedIds.has(item.id));
                }
            });
        },

        /**
         * Name a failed device for the result list.
         * @param {number} id Device id
         * @returns {string} The IP, or the id when the device is gone
         */
        failureLabel(id) {
            const device = this.devices.find((d) => d.id === id);
            return device ? device.ip : String(id);
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.ranges-input {
    font-family: monospace;
}

.label-input {
    min-width: 7rem;
}

.path-input {
    width: 9rem;
}

.port-input {
    max-width: 7rem;
}

.category-select {
    min-width: 8rem;
}

// Keeps the screen reader text inside the table from widening the page on a phone
.table-responsive {
    position: relative;
}

.bulk-bar {
    padding: 0.3rem 0.5rem;
    border: 1px solid rgba(128, 128, 128, 0.35);
    border-radius: 0.5rem;
    background: rgba(128, 128, 128, 0.1);
}

.group-row td {
    padding: 0;
}

.group-toggle {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 0.25rem 0.25rem;
    border: 0;
    background: transparent;
    color: inherit;
    font-weight: bold;
    text-align: left;
}

.group-subcategory .group-toggle {
    padding-left: 1.25rem;
    font-weight: 600;
}

.group-chevron {
    margin-right: 0.5rem;
    transition: transform 0.15s;

    &.collapsed {
        transform: rotate(-90deg);
    }
}

.indent-1 {
    padding-left: 1.5rem !important;
}

.indent-2 {
    padding-left: 3rem !important;
}

.sub-list {
    margin-left: 1.5rem;
}

.ping-dot {
    display: inline-block;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    margin-right: 0.25rem;
}

.ping-good {
    background: #0ca30c;
}

.ping-fair {
    background: #fab219;
}

.ping-slow {
    background: #d03b3b;
}

.device-table {
    font-size: 0.9rem;

    th {
        white-space: nowrap;
    }
}
</style>
