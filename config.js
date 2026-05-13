module.exports = {
    port: 3000,
    // Registračný poplatok za zápis agenta do systému (jednorazovo)
    registracny_poplatok_sat: 1000, 
    
    // Alby / Lightning konfigurácia (pre tvojich agentov)
    alby_token: 'YZVMMGZIN2QTM2YYNS0ZMMFILWE4NJGTOGFINGVMM2RJYTQ4',
    
    // Webhook tajomstvo (ak chceš overovať podpisy z BTCPay - odporúčané)
    btcpay_webhook_secret: process.env.BTCPAY_SECRET || '',

    // Pripojenie k Postgresu (BTCPay stack používa Docker sieť)
    db_config: {
        user: 'postgres',
        host: 'localhost', // alebo IP kontajnera, ak nebežíš lokálne
        database: 'btcpayservermainnet', 
        password: '', // doplň svoje heslo
        port: 5432,
    },

    ws_burzy: {
        binance: 'wss://stream.binance.com:9443/ws/btcusdt@ticker',
        bybit: 'wss://stream.bybit.com/v5/public/spot'
    }
};
