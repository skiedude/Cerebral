'use strict';

import React from 'react';
import Countdown from "react-countdown";


import DateTimeHelper from '../../helpers/DateTimeHelper';


export default class EveCountdownTimer extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            endDate: props.endDate || new Date(),
            intervalDelay: props.intervalDelay || 4500,
        };
    }

    renderEveTimer(totalMilliseconds, completed) {
        return completed ? null : DateTimeHelper.niceCountdown(totalMilliseconds);
    }

    render() {
        return (
            <Countdown
                date={this.state.endDate}
                intervalDelay={this.state.intervalDelay}
                renderer={({total, completed}) => this.renderEveTimer(total, completed)}
            />
        );
    }
}