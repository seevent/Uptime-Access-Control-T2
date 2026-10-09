exports.up = async function (knex) {
    await knex.schema.createTable("network_category", (table) => {
        table.increments("id");
        table.string("name", 100).notNullable();
        // null for a category (location); the id of a category for a sub category
        table
            .integer("parent_id")
            .unsigned()
            .nullable()
            .index()
            .references("id")
            .inTable("network_category")
            .onDelete("CASCADE");
    });

    await knex.schema.alterTable("network_device", (table) => {
        table
            .integer("category_id")
            .unsigned()
            .nullable()
            .index()
            .references("id")
            .inTable("network_category")
            .onDelete("SET NULL");
        table
            .integer("subcategory_id")
            .unsigned()
            .nullable()
            .index()
            .references("id")
            .inTable("network_category")
            .onDelete("SET NULL");
    });
};

exports.down = async function (knex) {
    await knex.schema.alterTable("network_device", (table) => {
        table.dropForeign("category_id");
        table.dropForeign("subcategory_id");
    });
    await knex.schema.alterTable("network_device", (table) => {
        table.dropColumn("category_id");
        table.dropColumn("subcategory_id");
    });
    await knex.schema.dropTable("network_category");
};
