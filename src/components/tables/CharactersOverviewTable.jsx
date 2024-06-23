'use strict';

import React from 'react';
import {Redirect} from 'react-router';

import Character from '../../models/Character';
import EveCountdownTimer from '../widgets/EveCountdownTimer';

import Avatar from 'material-ui/Avatar';
import {Table, TableBody, TableRow, TableRowColumn} from 'material-ui/Table';
import FontIcon from 'material-ui/FontIcon';
import {red500, greenA200, lightBlueA200} from 'material-ui/styles/colors';
import AuthorizedCharacter from '../../models/AuthorizedCharacter';

const styles = {
    charactersTable: {
        height: '100%',
        width: '100%'
    }
};

export default class CharactersOverviewTable extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            characters: Object.values(Character.getAll()).sort((a, b) => b.getTotalSp() - a.getTotalSp()),
            redirectPath: undefined
        };
    }

    componentDidMount() {
        this.subscriberId = Character.subscribe(this);
    }

    componentWillUnmount() {
        Character.unsubscribe(this.subscriberId);
    }

    handleClick(e, characterId) {
        let path = '/characters/' + characterId;

        this.setState({
            redirectPath: path
        });
    }

    render() {
        if (this.state.redirectPath !== undefined) {
            this.setState({redirectPath: undefined});

            return <Redirect push to={this.state.redirectPath}/>;
        }

        return (
            <Table style={styles.charactersTable}>
                <TableBody displayRowCheckbox={false}>
                    {this.state.characters.map(char => {
                        let omegaStatusIconPath = './../resources/';
                        switch (char.isOmega()) {
                            case true:
                                omegaStatusIconPath += 'omega.png';
                                break;
                            case false:
                                omegaStatusIconPath += 'alpha.png';
                                break;
                            default:
                                omegaStatusIconPath = '';
                        }
                        const currentSkill = char.getCurrentSkill();
                        const auth = AuthorizedCharacter.get(char.id);

                        return (
                            <TableRow key={char.id} selectable={false} onClick={(e) => this.handleClick(e, char.id)}>

                                <TableRowColumn style={{width: '20px'}}>
                                    <Avatar src={char.portraits.px128x128} style={{marginTop: 5}}/>
                                </TableRowColumn>

                                <TableRowColumn style={{width: 25, paddingLeft: 20, paddingRight: 0}}>
                                    <FontIcon className="material-icons" color={auth.lastRefresh.success !== false ? (auth.ssoVersion === 2 ? greenA200 : lightBlueA200) : red500} style={{marginTop: 5}}>
                                        {auth.lastRefresh.success !== false ? 'check_circle' : 'warning'}
                                    </FontIcon>
                                </TableRowColumn>

                                <TableRowColumn style={{width: '20px'}}>
                                    <img src={omegaStatusIconPath} style={{marginTop: 5}}/>
                                </TableRowColumn>

                                <TableRowColumn style={{width: '20px'}}>
                                    <img src={`https://image.eveonline.com/Corporation/${char.corporation_id}_64.png`} width={35} style={{marginTop: 7}}/>
                                </TableRowColumn>

                                <TableRowColumn>
                                    {char.name}<br/>
                                    {char.corporation.name} / {char.alliance_id !== undefined ? char.alliance.name : "N/A"}
                                </TableRowColumn>

                                <TableRowColumn style={{width: 120}}>
                                    {char.balance.toLocaleString(navigator.language, {maximumFractionDigits: 2})} ISK<br/>
                                    {char.getTotalSp().toLocaleString(navigator.language, {maximumFractionDigits: 0})} SP
                                </TableRowColumn>

                                <TableRowColumn>
                                    {currentSkill !== undefined ? `${currentSkill.skill_name} ${currentSkill.finished_level}` : "Not Training"}<br/>
                                    {currentSkill !== undefined ? <EveCountdownTimer endDate={new Date(currentSkill.finish_date)} /> : ""}
                                </TableRowColumn>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        );
    }
}
