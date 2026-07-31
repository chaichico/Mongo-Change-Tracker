const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, strict: false });

function validate(document, schema) {
  const validateFn = ajv.compile(schema);
  const valid = validateFn(document);
  return {
    valid,
    errors: valid
      ? []
      : validateFn.errors.map((e) => ({
          path: e.instancePath || "(root)",
          message: e.message,
          keyword: e.keyword,
          params: e.params,
        })),
  };
}

module.exports = { validate };
