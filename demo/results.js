window.RESULTS = {
  "meta": {
    "source": "demo/script/RunScenario.s.sol on anvil",
    "chainId": 31337,
    "token": "DEMO",
    "payment": "MON",
    "supply": "1000000000000000000000",
    "crowd": 12,
    "engine": "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
    "curve": "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
    "bot": "0x8464135c8F25Da09e49BC8782676a84730C318bC",
    "roundId": 1,
    "preset": "Degen",
    "deposit": "150000000000000000000",
    "tick": "1000000000000000",
    "commitWindowSec": 600,
    "revealWindowSec": 600,
    "transactions": 73
  },
  "curve": {
    "virtualToken": "2000000000000000000000",
    "virtualMon": "200000000000000000000",
    "openPrice": "100000000000000000",
    "finalSpot": "400000000000000000",
    "sold": "1000000000000000000000",
    "raised": "200000000000000000001",
    "fills": [
      {
        "who": "SNIPER BOT",
        "bot": true,
        "block": 1,
        "paid": "30000000000000000000",
        "tokens": "260869565217391304347",
        "spotAfter": "132249999999999999"
      },
      {
        "who": "SNIPER BOT",
        "bot": true,
        "block": 2,
        "paid": "25000000000000000000",
        "tokens": "170502983802216538789",
        "spotAfter": "162562499999999999"
      },
      {
        "who": "SNIPER BOT",
        "bot": true,
        "block": 3,
        "paid": "20000000000000000000",
        "tokens": "114081996434937611408",
        "spotAfter": "189062499999999999"
      },
      {
        "who": "ana",
        "bot": false,
        "block": 5,
        "paid": "30000000000000000000",
        "tokens": "143070044709388971684",
        "spotAfter": "232562499999999999"
      },
      {
        "who": "chloe",
        "bot": false,
        "block": 8,
        "paid": "36000000000000000000",
        "tokens": "138454881976828037113",
        "spotAfter": "290702499999999999"
      },
      {
        "who": "emi",
        "bot": false,
        "block": 11,
        "paid": "32000000000000000000",
        "tokens": "100634468878004292689",
        "spotAfter": "347822499999999999"
      },
      {
        "who": "ines",
        "bot": false,
        "block": 16,
        "paid": "27000000000000000001",
        "tokens": "72386058981233243970",
        "spotAfter": "400000000000000000"
      }
    ],
    "bot": {
      "tokens": "545454545454545454544",
      "paid": "75000000000000000000",
      "avgPrice": "137500000000000000"
    },
    "crowd": {
      "tokens": "454545454545454545456",
      "paid": "125000000000000000001",
      "avgPrice": "275000000000000000"
    }
  },
  "auction": {
    "clearingPrice": "220000000000000000",
    "sold": "1000000000000000000000",
    "demand": "1141940298006087479767",
    "oversubscribed": true,
    "collected": "220000000000000000004",
    "lpTokens": "199999999999999999999",
    "lpMon": "43999999999999999999",
    "lpLocked": true,
    "bot": {
      "tokens": "250000000000000000000",
      "paid": "55000000000000000000",
      "avgPrice": "220000000000000000"
    },
    "crowd": {
      "tokens": "750000000000000000000",
      "paid": "165000000000000000004",
      "avgPrice": "220000000000000000"
    }
  },
  "participants": [
    {
      "name": "SNIPER BOT",
      "address": "0x8464135c8F25Da09e49BC8782676a84730C318bC",
      "bot": true,
      "arrival": 0,
      "maxPrice": "500000000000000000",
      "budget": "75000000000000000000",
      "curve": {
        "status": "filled",
        "block": 1,
        "spotAtArrival": "100000000000000000",
        "tokens": "545454545454545454544",
        "paid": "75000000000000000000",
        "avgPrice": "137500000000000000"
      },
      "auction": {
        "hash": "0x801a3b2a4f43b2567695890bcd81a8c1d798f6dc91e8401fb305d6a2d4465693",
        "revealed": true,
        "claimed": true,
        "bidPrice": "500000000000000000",
        "bidAmount": "250000000000000000000",
        "allocated": "250000000000000000000",
        "paid": "55000000000000000000",
        "refund": "95000000000000000000",
        "pricePerToken": "220000000000000000",
        "status": "full"
      }
    },
    {
      "name": "ana",
      "address": "0x47eD977329f5EDF8B0d38c69bEC5A424b58a759E",
      "bot": false,
      "arrival": 1,
      "maxPrice": "400000000000000000",
      "budget": "30000000000000000000",
      "curve": {
        "status": "filled",
        "block": 5,
        "spotAtArrival": "189062499999999999",
        "tokens": "143070044709388971684",
        "paid": "30000000000000000000",
        "avgPrice": "209687500000000000"
      },
      "auction": {
        "hash": "0x2fbb2e46c2ea68680cd585ac840d6a7bbf6e551258ffd35317811ad19581974a",
        "revealed": true,
        "claimed": true,
        "bidPrice": "400000000000000000",
        "bidAmount": "75000000000000000000",
        "allocated": "75000000000000000000",
        "paid": "16500000000000000000",
        "refund": "133500000000000000000",
        "pricePerToken": "220000000000000000",
        "status": "full"
      }
    },
    {
      "name": "ben",
      "address": "0xf98d407177Ea1C705E01542D6aB8f32AB0B748F4",
      "bot": false,
      "arrival": 2,
      "maxPrice": "220000000000000000",
      "budget": "18000000000000000000",
      "curve": {
        "status": "priced out",
        "block": null,
        "spotAtArrival": "232562499999999999",
        "tokens": "0",
        "paid": "0",
        "avgPrice": "0"
      },
      "auction": {
        "hash": "0xa52623a4b914f66be1600e942fc7268433fd75b7c70be42289679acf4c36e26a",
        "revealed": true,
        "claimed": true,
        "bidPrice": "220000000000000000",
        "bidAmount": "81818181818181818181",
        "allocated": "9877883812094338414",
        "paid": "2173134438660754452",
        "refund": "147826865561339245548",
        "pricePerToken": "220000000000000000",
        "status": "partial"
      }
    },
    {
      "name": "chloe",
      "address": "0x5EB5E8B1Dd43A132Da22eaAF0a5BA43AEDb1C890",
      "bot": false,
      "arrival": 3,
      "maxPrice": "350000000000000000",
      "budget": "36000000000000000000",
      "curve": {
        "status": "filled",
        "block": 8,
        "spotAtArrival": "232562499999999999",
        "tokens": "138454881976828037113",
        "paid": "36000000000000000000",
        "avgPrice": "260012500000000000"
      },
      "auction": {
        "hash": "0x5c8090e424dcce613526c6650a8cb6fbbb2e2c99b6511a637260b6098ed40152",
        "revealed": true,
        "claimed": true,
        "bidPrice": "350000000000000000",
        "bidAmount": "102857142857142857142",
        "allocated": "102857142857142857142",
        "paid": "22628571428571428572",
        "refund": "127371428571428571428",
        "pricePerToken": "220000000000000000",
        "status": "full"
      }
    },
    {
      "name": "dev",
      "address": "0x01396c612D3705a4D1e4e0273701c4DE0a04d651",
      "bot": false,
      "arrival": 4,
      "maxPrice": "200000000000000000",
      "budget": "14000000000000000000",
      "curve": {
        "status": "priced out",
        "block": null,
        "spotAtArrival": "290702499999999999",
        "tokens": "0",
        "paid": "0",
        "avgPrice": "0"
      },
      "auction": {
        "hash": "0x056e02b5aeab65b5d53bd91cdee68913e1b6d704c5d9a44c90ad18bfc46e6700",
        "revealed": true,
        "claimed": true,
        "bidPrice": "200000000000000000",
        "bidAmount": "70000000000000000000",
        "allocated": "0",
        "paid": "0",
        "refund": "150000000000000000000",
        "pricePerToken": "0",
        "status": "refunded"
      }
    },
    {
      "name": "emi",
      "address": "0x8b3118A06B923485d929305fcAe66ddB23e1c0cC",
      "bot": false,
      "arrival": 5,
      "maxPrice": "500000000000000000",
      "budget": "32000000000000000000",
      "curve": {
        "status": "filled",
        "block": 11,
        "spotAtArrival": "290702499999999999",
        "tokens": "100634468878004292689",
        "paid": "32000000000000000000",
        "avgPrice": "317982500000000000"
      },
      "auction": {
        "hash": "0xd89e4335e3b973dc5a71f533f536370c40b53b26fb49dc8a0f3cf708f8f08025",
        "revealed": true,
        "claimed": true,
        "bidPrice": "500000000000000000",
        "bidAmount": "64000000000000000000",
        "allocated": "64000000000000000000",
        "paid": "14080000000000000000",
        "refund": "135920000000000000000",
        "pricePerToken": "220000000000000000",
        "status": "full"
      }
    },
    {
      "name": "finn",
      "address": "0x0E5B1F047f85F8E693D740197d15c8A5595717DC",
      "bot": false,
      "arrival": 6,
      "maxPrice": "260000000000000000",
      "budget": "20000000000000000000",
      "curve": {
        "status": "priced out",
        "block": null,
        "spotAtArrival": "347822499999999999",
        "tokens": "0",
        "paid": "0",
        "avgPrice": "0"
      },
      "auction": {
        "hash": "0x28eaf3b40cd67d7417fbbc40a0f1e60f698ce34dc4b59ee7944d458fb966b7e3",
        "revealed": true,
        "claimed": true,
        "bidPrice": "260000000000000000",
        "bidAmount": "76923076923076923076",
        "allocated": "76923076923076923076",
        "paid": "16923076923076923077",
        "refund": "133076923076923076923",
        "pricePerToken": "220000000000000000",
        "status": "full"
      }
    },
    {
      "name": "gia",
      "address": "0x5Fd471aa5239e12B7BfCfd8C5cc76f34018fD0e8",
      "bot": false,
      "arrival": 7,
      "maxPrice": "300000000000000000",
      "budget": "24000000000000000000",
      "curve": {
        "status": "priced out",
        "block": null,
        "spotAtArrival": "347822499999999999",
        "tokens": "0",
        "paid": "0",
        "avgPrice": "0"
      },
      "auction": {
        "hash": "0xebba38da27fbaf3a4d5ee002b97385f89825612d5d40202546a0265c6f28baef",
        "revealed": true,
        "claimed": true,
        "bidPrice": "300000000000000000",
        "bidAmount": "80000000000000000000",
        "allocated": "80000000000000000000",
        "paid": "17600000000000000000",
        "refund": "132400000000000000000",
        "pricePerToken": "220000000000000000",
        "status": "full"
      }
    },
    {
      "name": "hugo",
      "address": "0x4b318f71f423299b7104Cf18253589E2a609685f",
      "bot": false,
      "arrival": 8,
      "maxPrice": "240000000000000000",
      "budget": "16000000000000000000",
      "curve": {
        "status": "priced out",
        "block": null,
        "spotAtArrival": "347822499999999999",
        "tokens": "0",
        "paid": "0",
        "avgPrice": "0"
      },
      "auction": {
        "hash": "0xf9158ca481e53f15f04da79088d8f5ac9c86af0d53ba5885977c8fad51bbc04f",
        "revealed": true,
        "claimed": true,
        "bidPrice": "240000000000000000",
        "bidAmount": "66666666666666666666",
        "allocated": "66666666666666666666",
        "paid": "14666666666666666667",
        "refund": "135333333333333333333",
        "pricePerToken": "220000000000000000",
        "status": "full"
      }
    },
    {
      "name": "ines",
      "address": "0x414d3566eEFaCeE1d3CF8C67E05c84a8B0B4C06D",
      "bot": false,
      "arrival": 9,
      "maxPrice": "450000000000000000",
      "budget": "28000000000000000000",
      "curve": {
        "status": "filled",
        "block": 16,
        "spotAtArrival": "347822499999999999",
        "tokens": "72386058981233243970",
        "paid": "27000000000000000001",
        "avgPrice": "373000000000000000"
      },
      "auction": {
        "hash": "0x00d9d14134cfd4c66f4f818789694febdb4a160a52f20e3e9f06800ea21c7179",
        "revealed": true,
        "claimed": true,
        "bidPrice": "450000000000000000",
        "bidAmount": "62222222222222222222",
        "allocated": "62222222222222222222",
        "paid": "13688888888888888889",
        "refund": "136311111111111111111",
        "pricePerToken": "220000000000000000",
        "status": "full"
      }
    },
    {
      "name": "jay",
      "address": "0xcDb3B7C84368CC4A7a687062eCA8d022d0E4AF7f",
      "bot": false,
      "arrival": 10,
      "maxPrice": "280000000000000000",
      "budget": "22000000000000000000",
      "curve": {
        "status": "sold out",
        "block": null,
        "spotAtArrival": "400000000000000000",
        "tokens": "0",
        "paid": "0",
        "avgPrice": "0"
      },
      "auction": {
        "hash": "0xb8a9f284fa47d4b236635b61d99126f16e47643225ad6f082fd03d42a8f7cd58",
        "revealed": true,
        "claimed": true,
        "bidPrice": "280000000000000000",
        "bidAmount": "78571428571428571428",
        "allocated": "78571428571428571428",
        "paid": "17285714285714285715",
        "refund": "132714285714285714285",
        "pricePerToken": "220000000000000000",
        "status": "full"
      }
    },
    {
      "name": "kai",
      "address": "0x2BE1c42dc63C6390b8b9486Ee50DFDDf12dD2659",
      "bot": false,
      "arrival": 11,
      "maxPrice": "320000000000000000",
      "budget": "26000000000000000000",
      "curve": {
        "status": "sold out",
        "block": null,
        "spotAtArrival": "400000000000000000",
        "tokens": "0",
        "paid": "0",
        "avgPrice": "0"
      },
      "auction": {
        "hash": "0x218039bdb5b6f3d5d09e923b91a6f859706367242c476ffdd1ab3f1beb4ad729",
        "revealed": true,
        "claimed": true,
        "bidPrice": "320000000000000000",
        "bidAmount": "81250000000000000000",
        "allocated": "81250000000000000000",
        "paid": "17875000000000000000",
        "refund": "132125000000000000000",
        "pricePerToken": "220000000000000000",
        "status": "full"
      }
    },
    {
      "name": "lea",
      "address": "0xA2D7541eed4Dd4542b5e8992b089a5ABd47f22c2",
      "bot": false,
      "arrival": 12,
      "maxPrice": "380000000000000000",
      "budget": "20000000000000000000",
      "curve": {
        "status": "sold out",
        "block": null,
        "spotAtArrival": "400000000000000000",
        "tokens": "0",
        "paid": "0",
        "avgPrice": "0"
      },
      "auction": {
        "hash": "0x36445e971d411cab88c481f03621d101f88b984e6343bd2ce43b7d9e165d73e9",
        "revealed": true,
        "claimed": true,
        "bidPrice": "380000000000000000",
        "bidAmount": "52631578947368421052",
        "allocated": "52631578947368421052",
        "paid": "11578947368421052632",
        "refund": "138421052631578947368",
        "pricePerToken": "220000000000000000",
        "status": "full"
      }
    }
  ]
}
;
