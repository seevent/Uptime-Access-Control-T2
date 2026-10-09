// A device can depend on another device (a camera on its switch). While the device it depends on is down,
// the "down" alert of the dependent device is held back: one cause, one alert.
// Plain column without foreign key on purpose: deleting a device clears it in code (see deleteDevice).
exports.up = async function (knex) {
    await knex.schema.alterTable("network_device", (table) => {
        table.integer("depends_on_id").unsigned().nullable().index();
    });
};

exports.down = async function (knex) {
    await knex.schema.alterTable("network_device", (table) => {
        table.dropIndex("depends_on_id");
        table.dropColumn("depends_on_id");
    });
};
