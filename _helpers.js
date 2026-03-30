import jwt from 'jsonwebtoken';
import { queryDB } from './_db.js';

const JWT_SECRET = process.env.JWT_SECRET;

export function verifyToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }

    const token = authHeader.split(' ')[1];
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

export { queryDB };
