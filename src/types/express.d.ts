declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        role: 'BUYER' | 'SELLER' | 'ADMIN';
      };
    }
  }
}

export {};
