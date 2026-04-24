import { asyncHandler } from './errorHandler.js';

export const validate = (schema) => asyncHandler(async (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true
    });

    if (error) {
        const messages = error.details.map(d => d.message);
        const err = new Error('Validation failed');
        err.statusCode = 400;
        err.details = messages;
        throw err;
    }

    req.body = value;
    next();
});
  
