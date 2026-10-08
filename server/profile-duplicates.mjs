const definitions={wallet_address:{code:'WALLET_ALREADY_REGISTERED',message:'Этот кошелёк уже зарегистрирован другим участником'},exchange_uid:{code:'UID_ALREADY_REGISTERED',message:'Этот UID уже зарегистрирован другим участником'}};
export function duplicateError(field,ApiError){const {code,message}=definitions[field];return new ApiError(409,code,message,[{field,message}]);}
export function mapDuplicateError(error,ApiError){
 if(error.code!=='23505')return error;
 const field=error.constraint==='wallets_wallet_address_unique'?'wallet_address':error.constraint==='partner_rewards_exchange_uid_unique'?'exchange_uid':null;
 return field?duplicateError(field,ApiError):error;
}
export async function checkProfileDuplicates(client,userId,body){
 const row=(await client.query('SELECT EXISTS(SELECT 1 FROM wallets WHERE wallet_address=$2 AND user_id<>$1) wallet_taken,EXISTS(SELECT 1 FROM partner_rewards WHERE exchange_uid=$3 AND user_id<>$1) uid_taken',[userId,body.wallet_address??null,body.exchange_uid??null])).rows[0];
 return {wallet_address:Object.hasOwn(body,'wallet_address')?{available:!row.wallet_taken}:null,exchange_uid:Object.hasOwn(body,'exchange_uid')?{available:!row.uid_taken}:null};
}
export async function assertProfileAvailable(client,userId,body,ApiError){
 const result=await checkProfileDuplicates(client,userId,body);
 for(const field of ['wallet_address','exchange_uid'])if(result[field]?.available===false)throw duplicateError(field,ApiError);
}
