'use strict';

const promiseDelay = require('promise-delay');
const aws = require('aws-sdk');
const lambda = new aws.Lambda();
const botBuilder = require('claudia-bot-builder');
const slackDelayedReply = botBuilder.slackDelayedReply;

const Airtable = require('airtable');
const _ = require('lodash');

let categories = {
    add: 'Add',
    today: 'Today',
    meals: 'Meals',
    help: 'Help',
    del: 'Delete',
    delete: 'Delete',
    remove: 'Delete',
    rm: 'Delete',
    last: 'Yesterday summary',
    yesterday: 'Yesterday summary',
    vitals: 'Vitals'
};
let views = _.keys(categories);

const api = botBuilder((message, apiRequest) => {

    const text = message.text;
    const action = _.first(_.split(text, " "));
    

  //const seconds = parseInt(message.text, 10);
  if (_.includes(views, action)) {

    if(action === 'help' || action === 'Help'){
        return 'Valid commands: `add`, `today`, `meals`, and `help`.\n' +
            '• To add an new entry: `/psas add "meal name", cat amt, cat amt,`\n' +
            '• To get today\'s totals: `/psas today`\n' +
            '• To get today\'s meals: `/psas meals`\n' +
            '• To delete meal: `/psas delete "4-digit code"`\n' + 
            '• To get Vitals: `/psas vitals`\n' + 
            '• To get Yesterday entries: `/psas yesterday`\n'; 
    }

    let view = categories[action];


    // Invoke the same Lambda function asynchronously, and do not wait for the response
    // this allows the initial request to end within three seconds, as requiured by Slack

    return new Promise((resolve, reject) => {

      lambda.invoke({
  			FunctionName: apiRequest.lambdaContext.functionName,
  			InvocationType: 'Event',
  			Payload: JSON.stringify({
                slackEvent: message,
                env: apiRequest.env
            }),
  			Qualifier: apiRequest.lambdaContext.functionVersion
  		}, (err, done) => {
        if (err) return reject(err);

        resolve();
      });
    })
      .then(() => {

            return { // the initial response
                text: `${view}`,
                response_type: 'in_channel'
            }
        })
      .catch(() => {
        return `Could not setup timer :(`
      });

  } else {

    return 'Wow, I missed that. Valida commands: `add`, `today`, `meals`, and `help`';
  }

});

// this will be executed before the normal routing.
// we detect if the event has a flag set by line 21,
// and if so, avoid normal procesing, running a delayed response instead

api.intercept((event) => {
    if (!event.slackEvent) // if this is a normal web request, let it run
        return event;

    const message = event.slackEvent;
    const seconds = 2;
    const env = event.env;
    var text = "";

    const base = new Airtable({apiKey: env.AIRTABLE_API_KEY}).base(env.AIRTABLE_BASE_PESAS);

    var utils = {

        /**
         * @desc Compute today's date
         * @param format boolean
         * @return string
         */
        today: (format) => {
            // if not format provided or false, then result: yyyy-m-d
            var dt = new Date();
            var yyyy = dt.getFullYear();
            var mm = dt.getMonth() + 1;
            var dd = dt.getDate();

            if(format){
                mm = (mm < 10)? "0" + mm : mm;
                dd = (dd < 10)? "0" + dd : dd;
            } 

            return yyyy + '-' + mm + '-' + dd;
        },

        /**
         * @desc Transform a date to YYYY-MM-DD format. Not date value, use today's date
         * @param date string
         * @return string
         */
        dateToYYYYMMDD: (date) => {
            if(!date) {
                date = new Date();
            } else {
                date = new Date(date);
            }

            return (date).toJSON().slice(0,10); // results => yyyy-mm-dd
        },

        /**
         * @desc Day before date. date = 'yyyy-mm-dd', then 'yyyy-mm-(dd-1)'
         * @param date string
         * @return string
         */
        yesterday:  (date) => {
            var dt = new Date(date);
            return new Date((dt.setDate(dt.getDate()-1))).toString();
        },

        // If today's time is 8pm or more use yesterday date
        // If today's time is 4am or less use yesterday date
        /**
         * @desc Compensate between the local time and the Airtable standar time
         * @param none
         * @return string
         */
        updateLocalDateOffset: () => {
            // get today's date
            var date = utils.today();
            // get the date in time format for 4am
            var at4am = (new Date(date + ' 04:00:00')).getTime();
            // get the date in time format for 8pm
            var at8pm = (new Date(date + ' 20:00:00')).getTime();

            // if date-time is between some space of time, then
            // use yesterday's date instead of today's date
            if(Date.now() > at8pm && Date.now() < at4am) 
                date = utils.dateToYYYYMMDD(utils.yesterday(date));

            return date;
        },

        /**
         * @desc Transform a date `yyyy-mm-dd` to a string date `Jun 01 2017`
         * @param stringDate
         * @return string
         */
        dateToString: (stringDate) => {
            return (new Date(stringDate)).toString().split(' ').splice(1,3).join(' ');
        },

        /**
         * @desc Transform a string `false` or `true` to boolean false or true
         * @param bool string
         * @return boolean
         */
        toBool: (bool) => { return (bool == 'true'); }

    };

    // => add 'meal name', sugar 3, flour 5
    var splitted = _.split(message.text, ","); // splitted[0] => add 'meal name'
    var action = _.first(_.split(splitted[0], " ")); // action => add
    var meal = _.join(_.drop(_.split(splitted[0], " ")), " "); // meal => meal name
    var cats = _.split(_.drop(splitted), ","); // cats => [sugar 3, flour 5]

    let totals = {vegetables: 0.0,fruits: 0.0,milk: 0.0,flour: 0.0,meat: 0.0,beans: 0.0,oil: 0.0,sugar: 0.0,
        alcohol: 0,exercise: 0,coffee: 0};
    let categories = _.keys(totals);

	var deleteRecord = (id, name) => {
		base('Meals').destroy(id, (err, deletedRecord) => {
			if (err) { console.error(err); return; }

			text = `Record "${name}" was Deleted.`;
		});
	};

    var dateToMMDD = (date) => {
        if(!date) date = new Date();
        
        var dt =  _.split(new Date(date).toLocaleString().split(', ')[0], " ");


        return (_.trim(dt[1]) + " " + _.trim(dt[2]));
    }

    if(action === 'add') {

        _.each(cats, (cat) => {
            var category = _.first(_.split(_.trim(cat), " "));
            if(!_.includes(categories, category)) action = category;
            var amount = _.trim(_.last(_.split(cat, " ")));

            totals[category] += (1 * amount);
        });

        if(action === 'add'){
            // Check if "time" is later than 8pm and earlier than 4pm
            // If it's true, then, use yesterday date.
            var date = utils.dateToYYYYMMDD(utils.updateLocalDateOffset());

            let data = {
                "Meal": meal,
                "Date": date,
                "User": ["recMoikKUTPURMlV9"]
            };

            var entries = [];
            _.each(categories, (category) => {
                entries[_.capitalize(category)] = totals[category];
            });

            var toAirtable = _.assign({}, data, entries);

            base('Meals').create(toAirtable, (err, record) => {

                if (err) { console.error(err); return; }

                text = `Added "${meal}" to PSAS Meals.`;
            });

        } else {

            text = `"${action}" is not a valid category. Nothing was posted.`;
        }


    } else if(action === 'today') {

        base('Meals').select({
            view: 'Today'
        }).firstPage((err, records) => {
            if(err) { console.error(err); return; }

            _.each(records, (record) => {
                _.each(categories, (key) => {
                    totals[key] += record.get(_.capitalize(key));
                });
            });
            _.each(categories, (key) => {
                text += _.capitalize(key) + ' ' + totals[key] + '\n';
            });
        });

    } else if(action === 'last' || action === 'yesterday') {

        base('Log').select({
            view: 'Main View',
            sort: [{field: "Date", direction: "desc"}],
            maxRecords: 1
        }).firstPage((err, records) => {

            if(err) { console.error(err); return; }

            if(_.isEmpty(records)){
                text = 'There are not records yet!. Eat healthy my friend!';
            } else {
                var record = records[0];
                _.each(categories, (key) => {
                    text += _.capitalize(key) + ' ' + record.get(_.capitalize(key)) + '\n';
                });
            }
        });

    } else if(action === 'delete' || action === 'del' || action === 'remove' || action === 'rm') {

        var handler = _.toUpper(_.last(_.split(message.text, " ")));
		var filterByFormula = '{Handler} = "' + handler + '"'; 

		base('Meals').select({
			view: 'Today',
			filterByFormula: filterByFormula
		}).firstPage((err, records) => {
			if (err) { console.error(err); return; }

			var id = records[0].getId();
			var name = records[0].get('Meal');
			deleteRecord(id, name);
		});


    } else if (action === 'vitals') {

        base('Vitals').select({
            view: 'Main View',
            maxRecords: 10,
            sort: [{field: "Date", direction: "desc"}]
        }).firstPage((err, records) => {
            if(err) { console.error(err); return; }

            _.each(records, (record) => {
                var dd = new Date(record.get('Date')).getDate();
                var mm = new Date(record.get('Date')).getMonth() + 1;

                text += '• `' + mm + '/' + dd + '` => ' + record.get('Weight') + '/' + record.get('Fat') + '\n';
            });
        });

    } else  {

        base('Meals').select({
            view: 'Today',
            field: ['Meal']
        }).firstPage((err, records) => {
            if(err) { console.error(err); return; }
            
            _.each(records, (record) => {
                text += '• ' + record.get('Handler') + ' ' + record.get('Meal') + '\n';
            });
        });

    }


    return promiseDelay(seconds * 1000).then(() => {

        return slackDelayedReply(message, {
            text: text,
            response_type: 'in_channel'
        })
    }).then(() => false); // prevent normal execution
});

module.exports = api;
