const generateKey = (length = CONSTANTS.VERIFICATION_TOKEN_LENGTH) => {
  let key = '';
  const possible = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let i = 0; i < length; i++) {
    key += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return key;
};

const generateOTP = (length = CONSTANTS.OTP_LENGTH) => {
  let key = '';
  const possible = '0123456789';
  for (let i = 0; i < length; i++) {
    key += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return key;
};

export {
  generateOTP,
  generateKey
};